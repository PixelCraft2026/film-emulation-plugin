//! Resumable resident graph kernels.
//!
//! The command is parsed exactly once when a node is activated.  Afterwards
//! every call advances one real pointwise or primitive chunk and returns the
//! work and memory traffic that was actually performed.

use super::*;

#[cfg(all(feature = "simd", target_arch = "wasm32"))]
use core::arch::wasm32::{
    f32x4_add, f32x4_convert_u32x4, f32x4_extract_lane, f32x4_mul, f32x4_splat,
    f32x4_sub, f64x2_add, f64x2_mul, f64x2_splat, i32x4, i32x4_mul, i32x4_splat,
    u32x4_shr, v128, v128_load, v128_store, v128_xor,
};

#[derive(Clone, Copy)]
pub(super) struct KernelCursor {
    pub node: usize,
    pub node_hash: u32,
    pub opcode: u16,
    pub input_slot: usize,
    pub output_slot: usize,
    pub phase: u32,
    pub channel: u32,
    pub lobe: u32,
    pub pass: u32,
    pub row: u32,
    pub column: u32,
    pub index: usize,
}

#[derive(Clone, Copy, Default)]
pub(super) struct KernelStep {
    pub work: u32,
    pub reads: u32,
    pub writes: u32,
    pub taps: u32,
    pub downsample_pixels: u32,
    pub upsample_pixels: u32,
    pub done: bool,
}

#[derive(Clone, Copy)]
struct StepMeta { phase: u32, channel: u32, lobe: u32, pass: u32 }

impl StepMeta {
    const fn new(phase: u32) -> Self { Self { phase, channel: 0, lobe: 0, pass: 0 } }
    const fn diffuse(phase: u32, channel: usize, lobe: usize) -> Self {
        Self { phase, channel: channel as u32, lobe: lobe as u32, pass: 0 }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Plane { Scratch(usize), Transient(usize) }

unsafe fn plane_ptr(state: &ResidentState, plane: Plane, length: usize) -> Result<*const f32, i32> {
    match plane {
        Plane::Scratch(offset) if offset.saturating_add(length) <= state.scratch.len() => Ok(state.scratch.as_ptr().add(offset)),
        Plane::Transient(offset) if offset.saturating_add(length) <= state.transient.len() => Ok(state.transient.as_ptr().add(offset)),
        _ => Err(ERR_CAPACITY),
    }
}

unsafe fn plane_mut_ptr(state: &mut ResidentState, plane: Plane, length: usize) -> Result<*mut f32, i32> {
    match plane {
        Plane::Scratch(offset) if offset.saturating_add(length) <= state.scratch.len() => Ok(state.scratch.as_mut_ptr().add(offset)),
        Plane::Transient(offset) if offset.saturating_add(length) <= state.transient.len() => Ok(state.transient.as_mut_ptr().add(offset)),
        _ => Err(ERR_CAPACITY),
    }
}

unsafe fn frame_ptr(state: &ResidentState, physical: usize, length: usize) -> Result<*const f32, i32> {
    match physical {
        0 if length <= state.frame_a.len() => Ok(state.frame_a.as_ptr()),
        1 if length <= state.frame_b.len() => Ok(state.frame_b.as_ptr()),
        _ => Err(ERR_CAPACITY),
    }
}

unsafe fn frame_mut_ptr(state: &mut ResidentState, physical: usize, length: usize) -> Result<*mut f32, i32> {
    match physical {
        0 if length <= state.frame_a.len() => Ok(state.frame_a.as_mut_ptr()),
        1 if length <= state.frame_b.len() => Ok(state.frame_b.as_mut_ptr()),
        _ => Err(ERR_CAPACITY),
    }
}

fn add_u32(value: &mut u32, add: usize) { *value = value.saturating_add(add.min(u32::MAX as usize) as u32); }

#[inline(always)]
fn apply_masked_effect(original: f32, effected: f32, coverage: f32, mask_enabled: bool) -> f32 {
    if mask_enabled { original + (effected - original) * coverage } else { effected }
}

#[inline(always)]
fn finite_rgb(value: [f32; 3]) -> Result<[f32; 3], i32> {
    if value[0].is_finite() && value[1].is_finite() && value[2].is_finite() { Ok(value) }
    else { Err(ERR_NONFINITE_OUTPUT) }
}

/// Advances four independent vertical van Vliet recurrences.  The two-lane
/// f64 vectors keep the scalar operation order for each column; only the four
/// independent columns execute in parallel.  This is deliberately confined to
/// the SIMD artifact so the scalar module remains the frozen authority.
#[cfg(all(feature = "simd", target_arch = "wasm32"))]
#[inline(always)]
unsafe fn vv_recurrence_simd4(
    samples: *mut f64,
    y1: &mut [f64; 4],
    y2: &mut [f64; 4],
    y3: &mut [f64; 4],
    b: f64,
    b1: f64,
    b2: f64,
    b3: f64,
    inv_b0: f64,
) {
    let vb = f64x2_splat(b);
    let vb1 = f64x2_splat(b1);
    let vb2 = f64x2_splat(b2);
    let vb3 = f64x2_splat(b3);
    let vinv_b0 = f64x2_splat(inv_b0);
    for offset in [0usize, 2usize] {
        let x = v128_load(samples.add(offset) as *const v128);
        let previous1 = v128_load(y1.as_ptr().add(offset) as *const v128);
        let previous2 = v128_load(y2.as_ptr().add(offset) as *const v128);
        let previous3 = v128_load(y3.as_ptr().add(offset) as *const v128);
        let feedback = f64x2_add(
            f64x2_add(f64x2_mul(vb1, previous1), f64x2_mul(vb2, previous2)),
            f64x2_mul(vb3, previous3),
        );
        let output = f64x2_add(f64x2_mul(vb, x), f64x2_mul(feedback, vinv_b0));
        v128_store(y3.as_mut_ptr().add(offset) as *mut v128, previous2);
        v128_store(y2.as_mut_ptr().add(offset) as *mut v128, previous1);
        v128_store(y1.as_mut_ptr().add(offset) as *mut v128, output);
        v128_store(samples.add(offset) as *mut v128, output);
    }
}

#[cfg(all(feature = "simd", target_arch = "wasm32"))]
#[inline(always)]
fn fmix32x4(mut value: v128) -> v128 {
    value = v128_xor(value, u32x4_shr(value, 16));
    value = i32x4_mul(value, i32x4_splat(0x85eb_ca6bu32 as i32));
    value = v128_xor(value, u32x4_shr(value, 13));
    value = i32x4_mul(value, i32x4_splat(0xc2b2_ae35u32 as i32));
    v128_xor(value, u32x4_shr(value, 16))
}

/// Generates the four independent Grain channels for one coordinate in one
/// vector.  Hash mixing and the twelve-uniform sum retain the scalar lane
/// order and seed semantics exactly.
#[cfg(all(feature = "simd", target_arch = "wasm32"))]
#[inline(always)]
fn gaussian_channels_simd(prefix: u32) -> [f32; 4] {
    let channels = i32x4(0, 1, 2, 3);
    let channel_prefix = fmix32x4(v128_xor(i32x4_splat(prefix as i32), channels));
    let scale = f32x4_splat(1.0_f32 / 4294967296.0_f32);
    let mut sum = f32x4_splat(0.0);
    for sample in 0..12 {
        let hash = fmix32x4(v128_xor(channel_prefix, i32x4_splat(sample)));
        sum = f32x4_add(sum, f32x4_mul(f32x4_convert_u32x4(hash), scale));
    }
    let result = f32x4_sub(sum, f32x4_splat(6.0));
    [
        f32x4_extract_lane::<0>(result),
        f32x4_extract_lane::<1>(result),
        f32x4_extract_lane::<2>(result),
        f32x4_extract_lane::<3>(result),
    ]
}

#[derive(Clone, Copy)]
enum BlurAlgorithm { Box3, Gaussian, VanVliet }

#[derive(Clone, Copy)]
enum BlurDestination {
    Replace(Plane, f32),
    Accumulate(Plane, f32),
    AccumulateInterleaved { plane: Plane, channel: usize, weight: f32 },
}

#[derive(Clone, Copy)]
struct BlurWorkspace {
    work_out: Plane,
    temp_a: Plane,
    temp_b: Plane,
    low_src: Plane,
    low_dst: Plane,
    low_temp_a: Plane,
    low_temp_b: Plane,
}

enum BlurStage { Downsample, Filter, Commit, Done }

struct BlurOp {
    meta: StepMeta,
    source: Plane,
    destination: BlurDestination,
    workspace: BlurWorkspace,
    width: usize,
    height: usize,
    sigma: f32,
    scale: usize,
    algorithm: BlurAlgorithm,
    stage: BlurStage,
    filter: Option<FilterOp>,
    index: usize,
    low_width: usize,
    low_height: usize,
}

impl BlurOp {
    fn new(meta: StepMeta, source: Plane, destination: BlurDestination, workspace: BlurWorkspace,
        width: usize, height: usize, sigma: f32, scale: usize, algorithm: BlurAlgorithm) -> Self {
        let scale = scale.max(1);
        let low_width = width.div_ceil(scale).max(1);
        let low_height = height.div_ceil(scale).max(1);
        Self { meta, source, destination, workspace, width, height, sigma, scale, algorithm,
            stage: if scale == 1 { BlurStage::Filter } else { BlurStage::Downsample }, filter: None,
            index: 0, low_width, low_height }
    }

    /// Reuse the immediately preceding lobe's immutable low-resolution source.
    /// Callers only set this when source plane, scale and workspace are equal.
    fn with_reused_downsample(mut self) -> Self {
        if self.scale > 1 { self.stage = BlurStage::Filter; }
        self
    }

    unsafe fn step(&mut self, state: &mut ResidentState, budget: usize) -> Result<KernelStep, i32> {
        let mut result = KernelStep::default();
        match self.stage {
            BlurStage::Downsample => {
                let total = self.low_width * self.low_height;
                let count = budget.min(total.saturating_sub(self.index));
                let source = plane_ptr(state, self.source, self.width * self.height)?;
                let destination = plane_mut_ptr(state, self.workspace.low_src, total)?;
                for output_index in self.index..self.index + count {
                    let y = output_index / self.low_width;
                    let x = output_index % self.low_width;
                    let y0 = y * self.scale;
                    let y1 = ((y + 1) * self.scale).min(self.height);
                    let x0 = x * self.scale;
                    let x1 = ((x + 1) * self.scale).min(self.width);
                    let mut sum = 0.0_f64;
                    let mut samples = 0usize;
                    for yy in y0..y1 { for xx in x0..x1 { sum += *source.add(yy * self.width + xx) as f64; samples += 1; } }
                    *destination.add(output_index) = (sum / samples.max(1) as f64) as f32;
                    add_u32(&mut result.reads, samples);
                }
                self.index += count;
                result.work = count as u32;
                result.writes = count as u32;
                result.downsample_pixels = count as u32;
                if self.index == total { self.index = 0; self.stage = BlurStage::Filter; }
            }
            BlurStage::Filter => {
                if self.filter.is_none() {
                    let (source, destination, temp_a, temp_b, width, height, sigma) = if self.scale == 1 {
                        (self.source, self.workspace.work_out, self.workspace.temp_a, self.workspace.temp_b,
                            self.width, self.height, self.sigma)
                    } else {
                        (self.workspace.low_src, self.workspace.low_dst, self.workspace.low_temp_a, self.workspace.low_temp_b,
                            self.low_width, self.low_height, self.sigma / self.scale as f32)
                    };
                    self.filter = Some(FilterOp::new(source, destination, temp_a, temp_b, width, height, sigma, self.algorithm));
                }
                let filter_result = self.filter.as_mut().unwrap().step(state, budget)?;
                result = filter_result;
                if filter_result.done {
                    self.filter = None;
                    let direct = self.scale == 1 && matches!(self.destination, BlurDestination::Replace(plane, weight) if plane == self.workspace.work_out && weight == 1.0);
                    if direct { self.stage = BlurStage::Done; result.done = true; }
                    else { self.stage = BlurStage::Commit; self.index = 0; result.done = false; }
                }
            }
            BlurStage::Commit => {
                let total = self.width * self.height;
                let count = budget.min(total.saturating_sub(self.index));
                let source = if self.scale == 1 {
                    plane_ptr(state, self.workspace.work_out, total)?
                } else {
                    plane_ptr(state, self.workspace.low_dst, self.low_width * self.low_height)?
                };
                let (plane, channel, weight, accumulate) = match self.destination {
                    BlurDestination::Replace(plane, weight) => (plane, None, weight, false),
                    BlurDestination::Accumulate(plane, weight) => (plane, None, weight, true),
                    BlurDestination::AccumulateInterleaved { plane, channel, weight } => (plane, Some(channel), weight, true),
                };
                let destination_length = if channel.is_some() { total * 3 } else { total };
                let destination = plane_mut_ptr(state, plane, destination_length)?;
                for output_index in self.index..self.index + count {
                    let value = if self.scale == 1 { *source.add(output_index) } else {
                        let y = output_index / self.width;
                        let x = output_index % self.width;
                        let inverse = 1.0_f64 / self.scale as f64;
                        let fy = (y as f64 + 0.5) * inverse - 0.5;
                        let y0 = if fy < 0.0 { 0 } else if fy >= (self.low_height - 1) as f64 { self.low_height - 1 } else { fy.floor() as usize };
                        let y1 = (y0 + 1).min(self.low_height - 1);
                        let ty = fy - y0 as f64;
                        let fx = (x as f64 + 0.5) * inverse - 0.5;
                        let x0 = if fx < 0.0 { 0 } else if fx >= (self.low_width - 1) as f64 { self.low_width - 1 } else { fx.floor() as usize };
                        let x1 = (x0 + 1).min(self.low_width - 1);
                        let tx = fx - x0 as f64;
                        let top = *source.add(y0 * self.low_width + x0) as f64
                            + (*source.add(y0 * self.low_width + x1) as f64 - *source.add(y0 * self.low_width + x0) as f64) * tx;
                        let bottom = *source.add(y1 * self.low_width + x0) as f64
                            + (*source.add(y1 * self.low_width + x1) as f64 - *source.add(y1 * self.low_width + x0) as f64) * tx;
                        add_u32(&mut result.reads, 4);
                        (top + (bottom - top) * ty) as f32
                    };
                    let target_index = channel.map(|value| output_index * 3 + value).unwrap_or(output_index);
                    if accumulate { *destination.add(target_index) += value * weight; result.reads = result.reads.saturating_add(1); }
                    else { *destination.add(target_index) = value * weight; }
                    if self.scale == 1 { result.reads = result.reads.saturating_add(1); }
                }
                self.index += count;
                result.work = count as u32;
                result.writes = count as u32;
                if self.scale > 1 { result.upsample_pixels = count as u32; }
                if self.index == total { self.stage = BlurStage::Done; result.done = true; }
            }
            BlurStage::Done => result.done = true,
        }
        Ok(result)
    }
}

enum FilterStage {
    Copy { index: usize },
    GaussianInit { index: usize, sum: f32 },
    GaussianNormalize { index: usize, sum: f32 },
    GaussianHorizontal { index: usize },
    GaussianVertical { index: usize },
    BoxInit { pass: usize, vertical: bool, line: usize, init: usize, acc: f32 },
    BoxRun { pass: usize, vertical: bool, line: usize, position: usize, acc: f32 },
    VvFill { axis: usize, line: usize, index: usize },
    VvForward { axis: usize, line: usize, index: usize, y1: f64, y2: f64, y3: f64 },
    VvBackward { axis: usize, line: usize, index: usize, y1: f64, y2: f64, y3: f64 },
    VvWrite { axis: usize, line: usize, index: usize },
    // PF-11 keeps the horizontal result planar and filters a small block of
    // columns directly.  The old implementation transposed the complete
    // plane before and after the vertical recursion, adding four full memory
    // operations per pixel for every Quality blur.
    VvVerticalFill { line: usize, block: usize, index: usize },
    VvVerticalForward { line: usize, block: usize, index: usize, y1: [f64; 4], y2: [f64; 4], y3: [f64; 4] },
    VvVerticalBackward { line: usize, block: usize, index: usize, y1: [f64; 4], y2: [f64; 4], y3: [f64; 4] },
    VvVerticalWrite { line: usize, block: usize, index: usize },
    Done,
}

struct FilterOp {
    source: Plane,
    destination: Plane,
    temp_a: Plane,
    temp_b: Plane,
    width: usize,
    height: usize,
    sigma: f32,
    stage: FilterStage,
}

impl FilterOp {
    fn new(source: Plane, destination: Plane, temp_a: Plane, temp_b: Plane,
        width: usize, height: usize, sigma: f32, algorithm: BlurAlgorithm) -> Self {
        let identity = match algorithm {
            BlurAlgorithm::Box3 => radius_for_sigma(sigma) == 0,
            BlurAlgorithm::Gaussian => gaussian_radius(sigma) == 0,
            BlurAlgorithm::VanVliet => sigma <= 0.0,
        };
        let stage = if identity { FilterStage::Copy { index: 0 } } else { match algorithm {
            BlurAlgorithm::Box3 => FilterStage::BoxInit { pass: 0, vertical: false, line: 0, init: 0, acc: 0.0 },
            BlurAlgorithm::Gaussian => FilterStage::GaussianInit { index: 0, sum: 0.0 },
            BlurAlgorithm::VanVliet => FilterStage::VvFill { axis: 0, line: 0, index: 0 },
        }};
        Self { source, destination, temp_a, temp_b, width, height, sigma, stage }
    }

    unsafe fn step(&mut self, state: &mut ResidentState, budget: usize) -> Result<KernelStep, i32> {
        let mut result = KernelStep::default();
        let total = self.width * self.height;
        let op_source=self.source;let op_destination=self.destination;let op_temp_a=self.temp_a;let op_temp_b=self.temp_b;
        let box_planes=|pass:usize,vertical:bool|if !vertical{(match pass{0=>op_source,1=>op_destination,_=>op_temp_b},op_temp_a)}else{(op_temp_a,match pass{0=>op_destination,1=>op_temp_b,_=>op_destination})};
        match &mut self.stage {
            FilterStage::Copy { index } => {
                let source = plane_ptr(state, self.source, total)?;
                let destination = plane_mut_ptr(state, self.destination, total)?;
                let count = budget.min(total.saturating_sub(*index));
                std::ptr::copy_nonoverlapping(source.add(*index), destination.add(*index), count);
                result.work = count as u32; result.reads = count as u32; result.writes = count as u32;
                *index += count;
                if *index == total { self.stage = FilterStage::Done; result.done = true; }
            }
            FilterStage::GaussianInit { index, sum } => {
                let radius = gaussian_radius(self.sigma);
                let size = radius * 2 + 1;
                if size > state.kernel.len() { return Err(ERR_CAPACITY); }
                let count = budget.min(size.saturating_sub(*index));
                let denominator = 2.0 * self.sigma * self.sigma;
                for i in *index..*index + count {
                    let offset = i as isize - radius as isize;
                    let value = (-(offset * offset) as f32 / denominator).exp();
                    state.kernel[i] = value; *sum += value;
                }
                *index += count; result.work = count as u32; result.writes = count as u32;
                if *index == size { self.stage = FilterStage::GaussianNormalize { index: 0, sum: *sum }; }
            }
            FilterStage::GaussianNormalize { index, sum } => {
                let size = gaussian_radius(self.sigma) * 2 + 1;
                let count = budget.min(size.saturating_sub(*index));
                for i in *index..*index + count { state.kernel[i] /= *sum; }
                *index += count; result.work = count as u32; result.reads = count as u32; result.writes = count as u32;
                if *index == size { self.stage = FilterStage::GaussianHorizontal { index: 0 }; }
            }
            FilterStage::GaussianHorizontal { index } => {
                let radius = gaussian_radius(self.sigma);
                let size = radius * 2 + 1;
                let source = plane_ptr(state, self.source, total)?;
                let destination = plane_mut_ptr(state, self.temp_a, total)?;
                let count = budget.min(total.saturating_sub(*index));
                let end = *index + count;
                while *index < end {
                    let i = *index;
                    let y = i / self.width; let x = i % self.width; let mut value = 0.0;
                    #[cfg(all(feature = "simd", target_arch = "wasm32"))]
                    if end - i >= 4 && x >= radius && x + 3 + radius < self.width {
                        let mut vector = f32x4_splat(0.0);
                        for k in 0..size {
                            let samples = v128_load(source.add(y * self.width + x + k - radius) as *const v128);
                            vector = f32x4_add(vector, f32x4_mul(samples, f32x4_splat(state.kernel[k])));
                        }
                        v128_store(destination.add(i) as *mut v128, vector);
                        *index += 4;
                        continue;
                    }
                    for k in 0..size { let sx = (x as isize + k as isize - radius as isize).clamp(0, self.width as isize - 1) as usize; value += *source.add(y * self.width + sx) * state.kernel[k]; }
                    *destination.add(i) = value;
                    *index += 1;
                }
                result.work = count as u32; result.reads = (count * size) as u32; result.writes = count as u32; result.taps = (count * size) as u32;
                if *index == total { self.stage = FilterStage::GaussianVertical { index: 0 }; }
            }
            FilterStage::GaussianVertical { index } => {
                let radius = gaussian_radius(self.sigma);
                let size = radius * 2 + 1;
                let source = plane_ptr(state, self.temp_a, total)?;
                let destination = plane_mut_ptr(state, self.destination, total)?;
                let count = budget.min(total.saturating_sub(*index));
                let end = *index + count;
                while *index < end {
                    let i = *index;
                    let y = i / self.width; let x = i % self.width; let mut value = 0.0;
                    #[cfg(all(feature = "simd", target_arch = "wasm32"))]
                    if end - i >= 4 && x + 3 < self.width {
                        let mut vector = f32x4_splat(0.0);
                        for k in 0..size {
                            let sy = (y as isize + k as isize - radius as isize).clamp(0, self.height as isize - 1) as usize;
                            let samples = v128_load(source.add(sy * self.width + x) as *const v128);
                            vector = f32x4_add(vector, f32x4_mul(samples, f32x4_splat(state.kernel[k])));
                        }
                        v128_store(destination.add(i) as *mut v128, vector);
                        *index += 4;
                        continue;
                    }
                    for k in 0..size { let sy = (y as isize + k as isize - radius as isize).clamp(0, self.height as isize - 1) as usize; value += *source.add(sy * self.width + x) * state.kernel[k]; }
                    *destination.add(i) = value;
                    *index += 1;
                }
                result.work = count as u32; result.reads = (count * size) as u32; result.writes = count as u32; result.taps = (count * size) as u32;
                if *index == total { self.stage = FilterStage::Done; result.done = true; }
            }
            FilterStage::BoxInit { pass, vertical, line, init, acc } => {
                let radius = radius_for_sigma(self.sigma);
                let (source_plane, _) = box_planes(*pass, *vertical);
                let source = plane_ptr(state, source_plane, total)?;
                if *vertical {
                    if state.kernel.len()<self.width{return Err(ERR_CAPACITY)}
                    let count=budget.min(self.width.saturating_sub(*init));let rows=radius.min(self.height-1);
                    for x in *init..*init+count{let mut value=radius as f32**source.add(x);for k in 0..=rows{value+=*source.add(k*self.width+x);}state.kernel[x]=value;}
                    *init+=count;result.work=count as u32;result.reads=(count*(rows+2))as u32;result.writes=count as u32;result.taps=(count*(rows+2))as u32;
                    if *init==self.width{self.stage=FilterStage::BoxRun{pass:*pass,vertical:true,line:0,position:0,acc:0.0};}
                    return Ok(result);
                }
                let line_length = if *vertical { self.height } else { self.width };
                let line_count = if *vertical { self.width } else { self.height };
                if *line >= line_count { return Err(ERR_INTERNAL); }
                let init_total = radius.min(line_length - 1) + 2;
                let count = budget.min(init_total.saturating_sub(*init));
                for item in *init..*init + count {
                    if item == 0 {
                        let source_index = if *vertical { *line } else { *line * self.width };
                        *acc = radius as f32 * *source.add(source_index);
                    } else {
                        let k = item - 1;
                        let source_index = if *vertical { k * self.width + *line } else { *line * self.width + k };
                        *acc += *source.add(source_index);
                    }
                }
                *init += count; result.work = count as u32; result.reads = count as u32; result.taps = count as u32;
                if *init == init_total { self.stage = FilterStage::BoxRun { pass: *pass, vertical: *vertical, line: *line, position: 0, acc: *acc }; }
            }
            FilterStage::BoxRun { pass, vertical, line, position, acc } => {
                let radius = radius_for_sigma(self.sigma);
                let denominator = (radius * 2 + 1) as f32;
                let (source_plane, destination_plane) = box_planes(*pass, *vertical);
                let source = plane_ptr(state, source_plane, total)?;
                let destination = plane_mut_ptr(state, destination_plane, total)?;
                if *vertical {
                    let count=budget.min(total.saturating_sub(*position));
                    for i in *position..*position+count{let y=i/self.width;let x=i%self.width;*destination.add(i)=state.kernel[x]/denominator;if y+1<self.height{let outgoing=(y as isize-radius as isize).clamp(0,self.height as isize-1)as usize;let incoming=(y+radius+1).min(self.height-1);state.kernel[x]-=*source.add(outgoing*self.width+x);state.kernel[x]+=*source.add(incoming*self.width+x);result.reads=result.reads.saturating_add(2);result.taps=result.taps.saturating_add(2);}}
                    *position+=count;result.work=count as u32;result.writes=count as u32;
                    if *position==total{if *pass<2{self.stage=FilterStage::BoxInit{pass:*pass+1,vertical:false,line:0,init:0,acc:0.0};}else{self.stage=FilterStage::Done;result.done=true;}}
                    return Ok(result);
                }
                let line_length = if *vertical { self.height } else { self.width };
                let line_count = if *vertical { self.width } else { self.height };
                let count = budget.min(line_length.saturating_sub(*position));
                for pos in *position..*position + count {
                    let output_index = if *vertical { pos * self.width + *line } else { *line * self.width + pos };
                    *destination.add(output_index) = *acc / denominator;
                    if pos + 1 < line_length {
                        let outgoing = (pos as isize - radius as isize).clamp(0, line_length as isize - 1) as usize;
                        let incoming = (pos + radius + 1).min(line_length - 1);
                        let out_index = if *vertical { outgoing * self.width + *line } else { *line * self.width + outgoing };
                        let in_index = if *vertical { incoming * self.width + *line } else { *line * self.width + incoming };
                        *acc -= *source.add(out_index); *acc += *source.add(in_index);
                        result.reads = result.reads.saturating_add(2); result.taps = result.taps.saturating_add(2);
                    }
                }
                *position += count; result.work = count as u32; result.writes = count as u32;
                if *position == line_length {
                    if *line + 1 < line_count { self.stage = FilterStage::BoxInit { pass: *pass, vertical: *vertical, line: *line + 1, init: 0, acc: 0.0 }; }
                    else if !*vertical { self.stage = FilterStage::BoxInit { pass: *pass, vertical: true, line: 0, init: 0, acc: 0.0 }; }
                    else if *pass < 2 { self.stage = FilterStage::BoxInit { pass: *pass + 1, vertical: false, line: 0, init: 0, acc: 0.0 }; }
                    else { self.stage = FilterStage::Done; result.done = true; }
                }
            }
            FilterStage::VvFill { axis, line, index } => {
                let length = if *axis == 0 { self.width } else { self.height };
                let lines = if *axis == 0 { self.height } else { self.width };
                let pad = (5.0 * self.sigma as f64).ceil().max(2.0) as usize;
                let padded = length + 2 * pad;
                if padded > state.line.len() || *line >= lines { return Err(ERR_CAPACITY); }
                let source_plane = if *axis == 0 { self.source } else { self.destination };
                let source = plane_ptr(state, source_plane, total)?;
                let count = budget.min(padded.saturating_sub(*index));
                for pos in *index..*index + count {
                    let coordinate = if pos < pad { (pad - pos).min(length - 1) }
                        else if pos < pad + length { pos - pad }
                        else { (length - 1).saturating_sub(pos - (pad + length - 1)) };
                    let source_index = if *axis == 0 { *line * self.width + coordinate } else { *line * self.height + coordinate };
                    state.line[pos] = *source.add(source_index) as f64;
                }
                *index += count; result.work = count as u32; result.reads = count as u32; result.writes = count as u32;
                if *index == padded { self.stage = FilterStage::VvForward { axis: *axis, line: *line, index: 0, y1: 0.0, y2: 0.0, y3: 0.0 }; }
            }
            FilterStage::VvForward { axis, line, index, y1, y2, y3 } => {
                let length = if *axis == 0 { self.width } else { self.height };
                let pad = (5.0 * self.sigma as f64).ceil().max(2.0) as usize;
                let padded = length + 2 * pad;
                let coefficients = vv_coefficients(self.sigma as f64);
                let inv_b0 = 1.0 / coefficients.b0;
                let count = budget.min(padded.saturating_sub(*index));
                for pos in *index..*index + count {
                    let output = coefficients.b * state.line[pos] + (coefficients.b1 * *y1 + coefficients.b2 * *y2 + coefficients.b3 * *y3) * inv_b0;
                    *y3 = *y2; *y2 = *y1; *y1 = output; state.line[pos] = output;
                }
                *index += count; result.work = count as u32; result.reads = count as u32; result.writes = count as u32; result.taps = count.saturating_mul(4) as u32;
                if *index == padded { self.stage = FilterStage::VvBackward { axis: *axis, line: *line, index: padded, y1: 0.0, y2: 0.0, y3: 0.0 }; }
            }
            FilterStage::VvBackward { axis, line, index, y1, y2, y3 } => {
                let coefficients = vv_coefficients(self.sigma as f64);
                let inv_b0 = 1.0 / coefficients.b0;
                let count = budget.min(*index);
                for _ in 0..count {
                    *index -= 1;
                    let output = coefficients.b * state.line[*index] + (coefficients.b1 * *y1 + coefficients.b2 * *y2 + coefficients.b3 * *y3) * inv_b0;
                    *y3 = *y2; *y2 = *y1; *y1 = output; state.line[*index] = output;
                }
                result.work = count as u32; result.reads = count as u32; result.writes = count as u32; result.taps = count.saturating_mul(4) as u32;
                if *index == 0 { self.stage = FilterStage::VvWrite { axis: *axis, line: *line, index: 0 }; }
            }
            FilterStage::VvWrite { axis, line, index } => {
                let length = if *axis == 0 { self.width } else { self.height };
                let lines = if *axis == 0 { self.height } else { self.width };
                let pad = (5.0 * self.sigma as f64).ceil().max(2.0) as usize;
                let destination_plane = self.temp_a;
                let destination = plane_mut_ptr(state, destination_plane, total)?;
                let count = budget.min(length.saturating_sub(*index));
                for coordinate in *index..*index + count {
                    let destination_index = if *axis == 0 { *line * self.width + coordinate } else { *line * self.height + coordinate };
                    *destination.add(destination_index) = state.line[coordinate + pad] as f32;
                }
                *index += count; result.work = count as u32; result.reads = count as u32; result.writes = count as u32;
                if *index == length {
                    if *line + 1 < lines { self.stage = FilterStage::VvFill { axis: *axis, line: *line + 1, index: 0 }; }
                    else if *axis == 0 {
                        let block = self.width.min(4);
                        self.stage = FilterStage::VvVerticalFill { line: 0, block, index: 0 };
                    } else { self.stage = FilterStage::Done; result.done = true; }
                }
            }
            FilterStage::VvVerticalFill { line, block, index } => {
                let pad = (5.0 * self.sigma as f64).ceil().max(2.0) as usize;
                let padded = self.height + 2 * pad;
                let total_block = padded * *block;
                if total_block > state.line.len() { return Err(ERR_CAPACITY); }
                let source = plane_ptr(state, self.temp_a, total)?;
                let count = budget.min(total_block.saturating_sub(*index));
                for flat in *index..*index + count {
                    let position = flat / *block;
                    let lane = flat % *block;
                    let coordinate = if position < pad { (pad - position).min(self.height - 1) }
                        else if position < pad + self.height { position - pad }
                        else { (self.height - 1).saturating_sub(position - (pad + self.height - 1)) };
                    state.line[flat] = *source.add(coordinate * self.width + *line + lane) as f64;
                }
                *index += count;
                result.work = count as u32; result.reads = count as u32; result.writes = count as u32;
                if *index == total_block {
                    self.stage = FilterStage::VvVerticalForward {
                        line: *line, block: *block, index: 0,
                        y1: [0.0; 4], y2: [0.0; 4], y3: [0.0; 4],
                    };
                }
            }
            FilterStage::VvVerticalForward { line, block, index, y1, y2, y3 } => {
                let pad = (5.0 * self.sigma as f64).ceil().max(2.0) as usize;
                let total_block = (self.height + 2 * pad) * *block;
                let coefficients = vv_coefficients(self.sigma as f64);
                let inv_b0 = 1.0 / coefficients.b0;
                let count = budget.min(total_block.saturating_sub(*index));
                let end = *index + count;
                while *index < end {
                    #[cfg(all(feature = "simd", target_arch = "wasm32"))]
                    if *block == 4 && *index % 4 == 0 && end - *index >= 4 {
                        vv_recurrence_simd4(
                            state.line.as_mut_ptr().add(*index), y1, y2, y3,
                            coefficients.b, coefficients.b1, coefficients.b2, coefficients.b3, inv_b0,
                        );
                        *index += 4;
                        continue;
                    }
                    let flat = *index;
                    let lane = flat % *block;
                    let output = coefficients.b * state.line[flat]
                        + (coefficients.b1 * y1[lane] + coefficients.b2 * y2[lane] + coefficients.b3 * y3[lane]) * inv_b0;
                    y3[lane] = y2[lane]; y2[lane] = y1[lane]; y1[lane] = output; state.line[flat] = output;
                    *index += 1;
                }
                result.work = count as u32; result.reads = count as u32; result.writes = count as u32;
                result.taps = count.saturating_mul(4) as u32;
                if *index == total_block {
                    self.stage = FilterStage::VvVerticalBackward {
                        line: *line, block: *block, index: total_block,
                        y1: [0.0; 4], y2: [0.0; 4], y3: [0.0; 4],
                    };
                }
            }
            FilterStage::VvVerticalBackward { line, block, index, y1, y2, y3 } => {
                let coefficients = vv_coefficients(self.sigma as f64);
                let inv_b0 = 1.0 / coefficients.b0;
                let count = budget.min(*index);
                let mut remaining = count;
                while remaining > 0 {
                    #[cfg(all(feature = "simd", target_arch = "wasm32"))]
                    if *block == 4 && *index % 4 == 0 && remaining >= 4 {
                        *index -= 4;
                        vv_recurrence_simd4(
                            state.line.as_mut_ptr().add(*index), y1, y2, y3,
                            coefficients.b, coefficients.b1, coefficients.b2, coefficients.b3, inv_b0,
                        );
                        remaining -= 4;
                        continue;
                    }
                    *index -= 1;
                    let lane = *index % *block;
                    let output = coefficients.b * state.line[*index]
                        + (coefficients.b1 * y1[lane] + coefficients.b2 * y2[lane] + coefficients.b3 * y3[lane]) * inv_b0;
                    y3[lane] = y2[lane]; y2[lane] = y1[lane]; y1[lane] = output; state.line[*index] = output;
                    remaining -= 1;
                }
                result.work = count as u32; result.reads = count as u32; result.writes = count as u32;
                result.taps = count.saturating_mul(4) as u32;
                if *index == 0 { self.stage = FilterStage::VvVerticalWrite { line: *line, block: *block, index: 0 }; }
            }
            FilterStage::VvVerticalWrite { line, block, index } => {
                let pad = (5.0 * self.sigma as f64).ceil().max(2.0) as usize;
                let total_block = self.height * *block;
                let destination = plane_mut_ptr(state, self.destination, total)?;
                let count = budget.min(total_block.saturating_sub(*index));
                for flat in *index..*index + count {
                    let y = flat / *block;
                    let lane = flat % *block;
                    *destination.add(y * self.width + *line + lane) = state.line[(y + pad) * *block + lane] as f32;
                }
                *index += count;
                result.work = count as u32; result.reads = count as u32; result.writes = count as u32;
                if *index == total_block {
                    let next_line = *line + *block;
                    if next_line < self.width {
                        let next_block = (self.width - next_line).min(4);
                        self.stage = FilterStage::VvVerticalFill { line: next_line, block: next_block, index: 0 };
                    } else { self.stage = FilterStage::Done; result.done = true; }
                }
            }
            FilterStage::Done => result.done = true,
        }
        Ok(result)
    }
}

#[derive(Clone, Copy)]
enum MaxDirection { Horizontal, Vertical }

struct MaxFilterOp {
    meta: StepMeta,
    source: Plane,
    destination: Plane,
    temp: Plane,
    width: usize,
    height: usize,
    radius: usize,
    direction: MaxDirection,
    line: usize,
    position: usize,
    next: usize,
    head: usize,
    tail: usize,
    identity_index: usize,
}

impl MaxFilterOp {
    fn new(meta: StepMeta, source: Plane, destination: Plane, temp: Plane,
        width: usize, height: usize, radius: usize) -> Self {
        Self { meta, source, destination, temp, width, height, radius,
            direction: MaxDirection::Horizontal, line: 0, position: 0, next: 0,
            head: 0, tail: 0, identity_index: 0 }
    }

    unsafe fn step(&mut self, state: &mut ResidentState, budget: usize) -> Result<KernelStep, i32> {
        let mut result = KernelStep::default();
        let total = self.width * self.height;
        const COLUMN_BLOCK: usize = 64;
        let required_deque = self.width.max(COLUMN_BLOCK * self.height + COLUMN_BLOCK * 3);
        if state.deque.len() < required_deque { return Err(ERR_CAPACITY); }
        if self.radius == 0 {
            let source = plane_ptr(state, self.source, total)?;
            let destination = plane_mut_ptr(state, self.destination, total)?;
            let count = budget.min(total.saturating_sub(self.identity_index));
            std::ptr::copy_nonoverlapping(source.add(self.identity_index), destination.add(self.identity_index), count);
            self.identity_index += count;
            result.work = count as u32; result.reads = count as u32; result.writes = count as u32;
            result.done = self.identity_index == total;
            return Ok(result);
        }
        if matches!(self.direction, MaxDirection::Vertical) {
            return self.step_vertical_blocked(state, budget);
        }
        let mut remaining = budget;
        let mut reads = 0usize;
        let mut writes = 0usize;
        let mut taps = 0usize;
        let mut work = 0usize;
        while remaining > 0 {
            let vertical = matches!(self.direction, MaxDirection::Vertical);
            let line_length = if vertical { self.height } else { self.width };
            let line_count = if vertical { self.width } else { self.height };
            let source_plane = if vertical { self.temp } else { self.source };
            let destination_plane = if vertical { self.destination } else { self.temp };
            let source = plane_ptr(state, source_plane, total)?;
            let destination = plane_mut_ptr(state, destination_plane, total)?;
            let source_index = |coordinate: usize| if vertical { coordinate * self.width + self.line } else { self.line * self.width + coordinate };
            let right = (self.position + self.radius).min(line_length - 1);
            while self.next <= right {
                let candidate_value = *source.add(source_index(self.next));
                reads += 1;
                while self.tail > self.head {
                    let tail_coordinate = state.deque[self.tail - 1];
                    let tail_value = *source.add(source_index(tail_coordinate));
                    reads += 1;
                    taps += 1;
                    if tail_value > candidate_value { break; }
                    self.tail -= 1;
                }
                state.deque[self.tail] = self.next;
                self.tail += 1;
                self.next += 1;
            }
            let left = self.position.saturating_sub(self.radius);
            while self.tail > self.head && state.deque[self.head] < left { self.head += 1; }
            if self.tail <= self.head { return Err(ERR_INTERNAL); }
            let maximum_coordinate = state.deque[self.head];
            *destination.add(source_index(self.position)) = *source.add(source_index(maximum_coordinate));
            reads += 1;
            writes += 1;
            work += 1;
            taps += 1;
            remaining -= 1;
            self.position += 1;
            if self.position < line_length { continue; }
            if self.line + 1 < line_count {
                self.line += 1; self.position = 0; self.next = 0; self.head = 0; self.tail = 0;
            } else if !vertical {
                self.direction = MaxDirection::Vertical; self.line = 0; self.position = 0; self.next = 0; self.head = 0; self.tail = 0;
                break;
            } else {
                result.done = true;
                break;
            }
        }
        add_u32(&mut result.reads, reads);
        add_u32(&mut result.writes, writes);
        add_u32(&mut result.taps, taps);
        add_u32(&mut result.work, work);
        Ok(result)
    }

    unsafe fn step_vertical_blocked(&mut self, state: &mut ResidentState, budget: usize) -> Result<KernelStep, i32> {
        const COLUMN_BLOCK: usize = 64;
        let total = self.width * self.height;
        let source = plane_ptr(state, self.temp, total)?;
        let destination = plane_mut_ptr(state, self.destination, total)?;
        let mut result = KernelStep::default();
        let mut remaining = budget;
        let mut reads = 0usize;
        let mut writes = 0usize;
        let mut taps = 0usize;
        let mut work = 0usize;
        while remaining > 0 {
            if self.line >= self.width { result.done = true; break; }
            let block_width = (self.width - self.line).min(COLUMN_BLOCK);
            let queue_length = block_width * self.height;
            let heads_base = queue_length;
            let tails_base = heads_base + block_width;
            let nexts_base = tails_base + block_width;
            if nexts_base + block_width > state.deque.len() { return Err(ERR_CAPACITY); }
            if self.position == 0 {
                state.deque[heads_base..heads_base + block_width].fill(0);
                state.deque[tails_base..tails_base + block_width].fill(0);
                state.deque[nexts_base..nexts_base + block_width].fill(0);
            }
            let y = self.position / block_width;
            let local_x = self.position % block_width;
            let x = self.line + local_x;
            let queue_base = local_x * self.height;
            let mut head = state.deque[heads_base + local_x];
            let mut tail = state.deque[tails_base + local_x];
            let mut next = state.deque[nexts_base + local_x];
            let bottom = (y + self.radius).min(self.height - 1);
            while next <= bottom {
                let candidate_value = *source.add(next * self.width + x);
                reads += 1;
                while tail > head {
                    let tail_y = state.deque[queue_base + tail - 1];
                    let tail_value = *source.add(tail_y * self.width + x);
                    reads += 1;
                    taps += 1;
                    if tail_value > candidate_value { break; }
                    tail -= 1;
                }
                state.deque[queue_base + tail] = next;
                tail += 1;
                next += 1;
            }
            let top = y.saturating_sub(self.radius);
            while tail > head && state.deque[queue_base + head] < top { head += 1; }
            if tail <= head { return Err(ERR_INTERNAL); }
            let maximum_y = state.deque[queue_base + head];
            *destination.add(y * self.width + x) = *source.add(maximum_y * self.width + x);
            state.deque[heads_base + local_x] = head;
            state.deque[tails_base + local_x] = tail;
            state.deque[nexts_base + local_x] = next;
            reads += 1;
            writes += 1;
            work += 1;
            taps += 1;
            remaining -= 1;
            self.position += 1;
            if self.position == block_width * self.height {
                self.line += block_width;
                self.position = 0;
                if self.line >= self.width { result.done = true; break; }
            }
        }
        add_u32(&mut result.reads, reads);
        add_u32(&mut result.writes, writes);
        add_u32(&mut result.taps, taps);
        add_u32(&mut result.work, work);
        Ok(result)
    }
}

#[derive(Clone, Copy)]
struct DefringeParams {
    input: usize, output: usize, amount: f32, threshold: f32, softness: f32,
    edge_sensitivity: f32, mask: ResidentMask,
}

#[derive(Clone, Copy)]
pub(super) struct BloomParams {
    input: usize, output: usize, threshold: f32, gate_end: f32,
    amplify: f32, saturation: f32, save_lights: f32, mask: ResidentMask,
}

#[derive(Clone, Copy)]
struct HighlightParams {
    input: usize, output: usize, base: usize, amount: f32,
    threshold: f32, gate_end: f32, mask: ResidentMask, missing: bool,
}

#[derive(Clone, Copy)]
struct ResolutionParams {
    input: usize, output: usize, amount: f32, toe_loss: f32,
    shoulder_loss: f32, mask: ResidentMask,
}

#[derive(Clone, Copy)]
struct HalationParams {
    input: usize, output: usize, strength: f32, threshold: f32,
    source_softness: f32, background_threshold: f32, background_softness: f32,
    source_impact: f32, amplify: f32, source_expansion: f32, blue_compensation: f32,
    color_density: f32, interior_protection: f32, hot_threshold: f32,
    hot_core_strength: f32, global_source_threshold: f32, spectral_sensitivity: f32,
    red_layer_bias: f32, global_diffusion: f32, center_attenuation: f32,
    spill_mix: f32, redshift: [f32; 3], screen: bool, mask: ResidentMask,
}

#[derive(Clone, Copy)]
struct GrainParams {
    input: usize, output: usize, amount: f32, iso: f32, positive: bool,
    mask: ResidentMask, field_width: usize, field_height: usize, field_pixels: usize,
    field_scale: usize, max_pad: usize, field_preview_scale: f32,
    field_origin_x: f32, field_origin_y: f32, exact_stride: Option<i32>,
    exact_origin_x: i32, exact_origin_y: i32, node_prefix: u32,
    shared_weight: f32, independent_weight: f32,
}

enum PointKind {
    DefringeExtract(DefringeParams),
    DefringeComposite(DefringeParams),
    BloomExtract(BloomParams),
    BloomComposite(BloomParams),
    HighlightProtect(HighlightParams),
    FusedBloomHighlight { bloom: BloomParams, highlight: HighlightParams },
    ResolutionWeights(ResolutionParams),
    ResolutionExtract { params: ResolutionParams, channel: usize },
    ResolutionComposite { params: ResolutionParams, channel: usize },
    HalationExtract(HalationParams),
    HalationExpansionSeed(HalationParams),
    HalationExpansionApply(HalationParams),
    HalationAmplify(HalationParams),
    HalationScaleDiffuse { channel: usize, factor: f32 },
    HalationDensityGate(HalationParams),
    HalationPotential(HalationParams),
    HalationGlobalSource(HalationParams),
    HalationGlobalAdd(HalationParams),
    HalationComposite(HalationParams),
    GrainInit(GrainParams),
    GrainGenerate { params: GrainParams, scale: usize },
    GrainAccumulate { params: GrainParams, shared: f32, independent: f32 },
    GrainComposite(GrainParams),
}

struct PointOp { meta: StepMeta, kind: PointKind, index: usize, total: usize }

impl PointOp {
    fn new(meta: StepMeta, kind: PointKind, total: usize) -> Self { Self { meta, kind, index: 0, total } }

    unsafe fn step(&mut self, state: &mut ResidentState, budget: usize) -> Result<KernelStep, i32> {
        let mut result = KernelStep::default();
        let count = budget.min(self.total.saturating_sub(self.index));
        let n = state.width * state.height;
        let values = n * 3;
        match self.kind {
            PointKind::DefringeExtract(_) => {
                let params = match self.kind { PointKind::DefringeExtract(value) => value, _ => unreachable!() };
                let input = frame_ptr(state, params.input, values)?;
                let y = plane_mut_ptr(state, Plane::Scratch(0), n)?;
                let cg = plane_mut_ptr(state, Plane::Scratch(n), n)?;
                for i in self.index..self.index + count { let p=i*3; let r=*input.add(p); let g=*input.add(p+1); let b=*input.add(p+2); *y.add(i)=(r+2.0*g+b)*0.25; *cg.add(i)=(-r+2.0*g-b)*0.25; }
                result.reads=(count*3) as u32; result.writes=(count*2) as u32;
            }
            PointKind::DefringeComposite(params) => {
                let input=frame_ptr(state,params.input,values)?; let output=frame_mut_ptr(state,params.output,values)?;
                let y=plane_ptr(state,Plane::Scratch(0),n)?; let cg=plane_ptr(state,Plane::Scratch(n),n)?;
                let y_blur=plane_ptr(state,Plane::Scratch(2*n),n)?; let cg_blur=plane_ptr(state,Plane::Scratch(3*n),n)?;
                for i in self.index..self.index+count { let p=i*3; let edge=(*y.add(i)-*y_blur.add(i)).abs(); let fringe=(*cg.add(i)-*cg_blur.add(i)).abs();
                    let edge_gate=resident_smoothstep(0.01/params.edge_sensitivity,0.08/params.edge_sensitivity,edge);
                    let chroma_gate=resident_smoothstep(params.threshold,params.threshold+params.softness,fringe);
                    let local_mix=params.amount*edge_gate*chroma_gate*state.alpha[i].clamp(0.0,1.0); let corrected=*cg.add(i)+(*cg_blur.add(i)-*cg.add(i))*local_mix;
                    let r=*input.add(p); let g=*input.add(p+1); let b=*input.add(p+2); let co=(r-b)*0.5; let effected=[*y.add(i)-corrected+co,*y.add(i)+corrected,*y.add(i)-corrected-co];
                    let coverage=resident_mask_coverage(params.mask,r,g,b);let final_rgb=finite_rgb([
                        apply_masked_effect(r,effected[0],coverage,params.mask.enabled),
                        apply_masked_effect(g,effected[1],coverage,params.mask.enabled),
                        apply_masked_effect(b,effected[2],coverage,params.mask.enabled),
                    ])?;for c in 0..3{*output.add(p+c)=final_rgb[c];} }
                result.reads=(count*14) as u32; result.writes=(count*3) as u32;
            }
            PointKind::BloomExtract(params) => {
                let input=frame_ptr(state,params.input,values)?; let source=plane_mut_ptr(state,Plane::Scratch(0),values)?; let contribution=plane_mut_ptr(state,Plane::Transient(0),values)?;
                for i in self.index..self.index+count {let p=i*3; let r=*input.add(p);let g=*input.add(p+1);let b=*input.add(p+2);let a=state.alpha[i].clamp(0.0,1.0);let gate=resident_smoothstep(params.threshold,params.gate_end,r.max(g).max(b));
                    let sr=r.max(0.0)*gate*a;let sg=g.max(0.0)*gate*a;let sb=b.max(0.0)*gate*a;let sy=0.2126*sr+0.7152*sg+0.0722*sb;
                    *source.add(i)=(sy+(sr-sy)*params.saturation).max(0.0);*source.add(n+i)=(sy+(sg-sy)*params.saturation).max(0.0);*source.add(2*n+i)=(sy+(sb-sy)*params.saturation).max(0.0);
                    *contribution.add(p)=0.0;*contribution.add(p+1)=0.0;*contribution.add(p+2)=0.0;}
                result.reads=(count*4) as u32;result.writes=(count*6) as u32;
            }
            PointKind::BloomComposite(params) => {
                let input=frame_ptr(state,params.input,values)?;let output=frame_mut_ptr(state,params.output,values)?;let contribution=plane_mut_ptr(state,Plane::Transient(0),values)?;
                for i in self.index..self.index+count {let p=i*3;let r=*input.add(p);let g=*input.add(p+1);let b=*input.add(p+2);let light=resident_smoothstep(params.threshold,params.gate_end,r.max(g).max(b));let keep=1.0-params.save_lights*light;let coverage=resident_mask_coverage(params.mask,r,g,b);
                    let mut final_rgb=[0.0;3];for c in 0..3 {let value=*contribution.add(p+c)*params.amplify*keep*coverage;*contribution.add(p+c)=value;final_rgb[c]=*input.add(p+c)+value;}let final_rgb=finite_rgb(final_rgb)?;for c in 0..3{*output.add(p+c)=final_rgb[c];}}
                result.reads=(count*9) as u32;result.writes=(count*6) as u32;
            }
            PointKind::HighlightProtect(params) => {
                let input=frame_ptr(state,params.input,values)?;let output=frame_mut_ptr(state,params.output,values)?;
                if params.missing {for index in self.index..self.index+count{let value=*input.add(index);if !value.is_finite(){return Err(ERR_NONFINITE_OUTPUT)}*output.add(index)=value;}result.reads=count as u32;result.writes=count as u32;}
                else {let base=frame_ptr(state,params.base,values)?;let contribution=plane_ptr(state,Plane::Transient(0),values)?;
                    for i in self.index..self.index+count {let p=i*3;let rgb=[*input.add(p),*input.add(p+1),*input.add(p+2)];let base_rgb=[*base.add(p),*base.add(p+1),*base.add(p+2)];let protection=resident_smoothstep(params.threshold,params.gate_end,base_rgb[0].max(base_rgb[1]).max(base_rgb[2]));let keep=1.0-params.amount*protection;let coverage=resident_mask_coverage(params.mask,rgb[0],rgb[1],rgb[2]);
                        let mut final_rgb=[0.0;3];for c in 0..3 {let effected=base_rgb[c]+*contribution.add(p+c)*keep;final_rgb[c]=apply_masked_effect(rgb[c],effected,coverage,params.mask.enabled);}let final_rgb=finite_rgb(final_rgb)?;for c in 0..3{*output.add(p+c)=final_rgb[c];}}
                    result.reads=(count*9) as u32;result.writes=(count*3) as u32;}
            }
            PointKind::FusedBloomHighlight { bloom, highlight } => {
                let base=frame_ptr(state,bloom.input,values)?;let output=frame_mut_ptr(state,highlight.output,values)?;let contribution=plane_mut_ptr(state,Plane::Transient(0),values)?;
                for i in self.index..self.index+count{let p=i*3;let base_rgb=[*base.add(p),*base.add(p+1),*base.add(p+2)];let light=resident_smoothstep(bloom.threshold,bloom.gate_end,base_rgb[0].max(base_rgb[1]).max(base_rgb[2]));let bloom_keep=1.0-bloom.save_lights*light;let bloom_coverage=resident_mask_coverage(bloom.mask,base_rgb[0],base_rgb[1],base_rgb[2]);let mut bloom_rgb=[0.0;3];let mut values_rgb=[0.0;3];for c in 0..3{let value=*contribution.add(p+c)*bloom.amplify*bloom_keep*bloom_coverage;*contribution.add(p+c)=value;values_rgb[c]=value;bloom_rgb[c]=base_rgb[c]+value;}let protection=resident_smoothstep(highlight.threshold,highlight.gate_end,base_rgb[0].max(base_rgb[1]).max(base_rgb[2]));let hp_keep=1.0-highlight.amount*protection;let hp_coverage=resident_mask_coverage(highlight.mask,bloom_rgb[0],bloom_rgb[1],bloom_rgb[2]);let final_rgb=finite_rgb([apply_masked_effect(bloom_rgb[0],base_rgb[0]+values_rgb[0]*hp_keep,hp_coverage,highlight.mask.enabled),apply_masked_effect(bloom_rgb[1],base_rgb[1]+values_rgb[1]*hp_keep,hp_coverage,highlight.mask.enabled),apply_masked_effect(bloom_rgb[2],base_rgb[2]+values_rgb[2]*hp_keep,hp_coverage,highlight.mask.enabled)])?;for c in 0..3{*output.add(p+c)=final_rgb[c];}}
                result.reads=(count*9)as u32;result.writes=(count*6)as u32;
            }
            PointKind::ResolutionWeights(params) => {
                let input=frame_ptr(state,params.input,values)?;let weights=plane_mut_ptr(state,Plane::Scratch(0),n)?;
                for i in self.index..self.index+count {let p=i*3;let lum=(0.2126**input.add(p)+0.7152**input.add(p+1)+0.0722**input.add(p+2)).max(1e-6);let exposure=resident_fast_log2(lum/0.18);let toe=1.0-resident_smoothstep(-6.0,-2.0,exposure);let shoulder=resident_smoothstep(2.0,6.0,exposure);*weights.add(i)=(params.amount*(1.0+params.toe_loss*toe+params.shoulder_loss*shoulder)).clamp(0.0,1.5);}
                result.reads=(count*3) as u32;result.writes=count as u32;
            }
            PointKind::ResolutionExtract { params, channel } => {
                let input=frame_ptr(state,params.input,values)?;let source=plane_mut_ptr(state,Plane::Scratch(n),n)?;
                for i in self.index..self.index+count {*source.add(i)=*input.add(i*3+channel);} result.reads=count as u32;result.writes=count as u32;
            }
            PointKind::ResolutionComposite { params, channel } => {
                let input=frame_ptr(state,params.input,values)?;let output=frame_mut_ptr(state,params.output,values)?;let weights=plane_ptr(state,Plane::Scratch(0),n)?;let source=plane_ptr(state,Plane::Scratch(n),n)?;let first=plane_ptr(state,Plane::Scratch(2*n),n)?;let wide=plane_ptr(state,Plane::Scratch(3*n),n)?;
                for i in self.index..self.index+count {let weight=*weights.add(i);let source_value=*source.add(i);let effected=if weight<=1.0{source_value+weight*(*first.add(i)-source_value)}else{(2.0-weight)**first.add(i)+(weight-1.0)**wide.add(i)};let p=i*3;let r=*input.add(p);let g=*input.add(p+1);let b=*input.add(p+2);let coverage=resident_mask_coverage(params.mask,r,g,b);let original=*input.add(p+channel);let value=apply_masked_effect(original,effected,coverage,params.mask.enabled);if !value.is_finite(){return Err(ERR_NONFINITE_OUTPUT)}*output.add(p+channel)=value;}
                result.reads=(count*10) as u32;result.writes=count as u32;
            }
            PointKind::HalationExtract(params) => {
                let input=frame_ptr(state,params.input,values)?;let luminance=plane_mut_ptr(state,Plane::Scratch(0),n)?;let local_gate=plane_mut_ptr(state,Plane::Scratch(n),n)?;
                let source_weight=plane_mut_ptr(state,Plane::Scratch(2*n),n)?;let source_exposure=plane_mut_ptr(state,Plane::Scratch(3*n),n)?;let authorization=plane_mut_ptr(state,Plane::Scratch(4*n),n)?;
                let source_r=plane_mut_ptr(state,Plane::Scratch(5*n),n)?;let source_g=plane_mut_ptr(state,Plane::Scratch(6*n),n)?;let source_b=plane_mut_ptr(state,Plane::Scratch(7*n),n)?;
                let t0=params.threshold-params.source_softness*0.5;let t1=params.threshold+params.source_softness*0.5;let g0=params.background_threshold-params.background_softness;let g1=params.background_threshold;
                let spectral_mix=resident_smoothstep(0.0,1.0,params.spectral_sensitivity.clamp(0.0,1.0));let bias=params.red_layer_bias.clamp(0.0,1.0);let spill=params.spill_mix.clamp(0.0,1.0);let blue=params.blue_compensation.clamp(0.0,1.0);
                for i in self.index..self.index+count {let p=i*3;let r=*input.add(p) as f64;let g=*input.add(p+1) as f64;let b=*input.add(p+2) as f64;let a=state.alpha[i].clamp(0.0,1.0) as f64;let y=0.2126*r+0.7152*g+0.0722*b;let m=r.max(g).max(b);*luminance.add(i)=y as f32;
                    let threshold_mask=resident_halation_extract::smoothstep_f64(t0 as f64,t1 as f64,y);let spill_mask=resident_halation_extract::smoothstep_f64(t0 as f64,t1 as f64,m);let legacy_mask=threshold_mask*(1.0-spill as f64)+spill_mask*spill as f64;let legacy_radiance=(y*(1.0-spill as f64)+m*spill as f64).max(0.0);let red_layer=(0.82*r+0.16*g+0.02*b).max(0.0);
                    let pr=r.max(0.0);let pg=g.max(0.0);let pb=b.max(0.0);let(mut red_gain,mut green_gain,mut blue_gain,mut red_conf)=(1.0,1.0,1.0,1.0);
                    if params.spectral_sensitivity>0.0 {let(saturation,hr,hg,hb)=resident_halation_extract::spectral_hue_response(pr,pg,pb);let purity=resident_halation_extract::smoothstep_f64(0.35,0.80,saturation);let mix=spectral_mix as f64*purity;red_gain+=mix*(hr-1.0);green_gain+=mix*(hg-1.0);blue_gain+=mix*(hb-1.0);red_conf+=mix*(hr.clamp(0.0,1.0)-1.0);}
                    let red_mask=resident_halation_extract::smoothstep_f64(t0 as f64,t1 as f64,red_layer);let legacy_response=resident_halation_extract::compressed_highlight_response(legacy_radiance,params.threshold as f64,params.source_impact as f64);let red_response=resident_halation_extract::compressed_highlight_response(red_layer,params.threshold as f64,params.source_impact as f64);
                    let legacy_amp=legacy_mask*a*legacy_response;let red_amp=red_mask*red_conf*a*red_response;let amplitude=legacy_amp+(red_amp-legacy_amp)*bias as f64;
                    let long_wave=0.82*r+0.18*g;let base_gate=1.0-resident_halation_extract::smoothstep_f64(g0 as f64,g1 as f64,long_wave.clamp(0.0,1.0));let peak=pr.max(pg).max(pb);let cool=if peak>1e-8{(pb-pr).max(0.0)/peak}else{0.0};*local_gate.add(i)=(base_gate+(1.0-base_gate)*cool*blue as f64) as f32;
                    let legacy_ev=resident_halation_extract::reconstructed_source_exposure(legacy_radiance,params.threshold as f64);let red_ev=resident_halation_extract::reconstructed_source_exposure(red_layer,params.threshold as f64)*red_conf;let exposure=legacy_ev+(red_ev-legacy_ev)*bias as f64;*source_exposure.add(i)=exposure as f32;*source_weight.add(i)=amplitude as f32;*authorization.add(i)=0.0;
                    let legacy_norm=if legacy_radiance>1e-8{legacy_amp/legacy_radiance}else{0.0};let red_norm=if red_layer>1e-8{red_amp/red_layer}else{0.0};let legacy_hot=resident_halation_extract::smoothstep_f64(params.hot_threshold as f64-0.25,params.hot_threshold as f64+0.25,legacy_ev);let red_hot=resident_halation_extract::smoothstep_f64(params.hot_threshold as f64-0.25,params.hot_threshold as f64+0.25,red_ev);
                    let red_incident=(0.82*pr+0.16*pg+0.02*pb).max(0.0);let green_incident=(0.08*pr+0.74*pg+0.03*pb).max(0.0);let blue_incident=(0.01*pr+0.03*pg+0.06*pb).max(0.0);
                    let lr=red_incident*legacy_norm*red_gain;let rr=red_incident*red_norm*red_gain;let lg=green_incident*legacy_norm*(0.12+0.88*legacy_hot)*green_gain;let rg=green_incident*red_norm*(0.12+0.88*red_hot)*green_gain;let lb=blue_incident*legacy_norm*blue_gain;let rb=blue_incident*red_norm*blue_gain;
                    *source_r.add(i)=(lr+(rr-lr)*bias as f64) as f32;*source_g.add(i)=(lg+(rg-lg)*bias as f64) as f32;*source_b.add(i)=(lb+(rb-lb)*bias as f64) as f32;}
                result.reads=(count*4) as u32;result.writes=(count*8) as u32;
            }
            PointKind::HalationExpansionSeed(params) => {
                let exposure=plane_ptr(state,Plane::Scratch(3*n),n)?;let source_r=plane_ptr(state,Plane::Scratch(5*n),n)?;let authorization=plane_mut_ptr(state,Plane::Scratch(4*n),n)?;
                for i in self.index..self.index+count {let hot=resident_smoothstep(params.hot_threshold-0.25,params.hot_threshold+0.25,*exposure.add(i));*authorization.add(i)=(*source_r.add(i)*hot).clamp(0.0,1.0);}result.reads=(count*2)as u32;result.writes=count as u32;
            }
            PointKind::HalationExpansionApply(params) => {
                let input=frame_ptr(state,params.input,values)?;let support=plane_ptr(state,Plane::Scratch(8*n),n)?;let weight=plane_mut_ptr(state,Plane::Scratch(2*n),n)?;let authorization=plane_mut_ptr(state,Plane::Scratch(4*n),n)?;let sr=plane_mut_ptr(state,Plane::Scratch(5*n),n)?;let sg=plane_mut_ptr(state,Plane::Scratch(6*n),n)?;
                let lower=(params.threshold*(1.0-0.68*params.source_expansion)).max(0.0);let candidate_end=(lower+(params.source_softness*2.0).max(0.02)).max(params.threshold);let bias=params.red_layer_bias.clamp(0.0,1.0);let spectral_mix=resident_smoothstep(0.0,1.0,params.spectral_sensitivity.clamp(0.0,1.0));
                for i in self.index..self.index+count {let p=i*3;let r=*input.add(p)as f64;let g=*input.add(p+1)as f64;let b=*input.add(p+2)as f64;let a=state.alpha[i].clamp(0.0,1.0)as f64;let y=0.2126*r+0.7152*g+0.0722*b;let m=r.max(g).max(b);let legacy=(y*(1.0-params.spill_mix as f64)+m*params.spill_mix as f64).max(0.0);let red=(0.82*r+0.16*g+0.02*b).max(0.0);let mut confidence=1.0;
                    if params.spectral_sensitivity>0.0 {let(sat,hr,_,_)=resident_halation_extract::spectral_hue_response(r.max(0.0),g.max(0.0),b.max(0.0));let purity=resident_halation_extract::smoothstep_f64(0.35,0.80,sat);let mix=spectral_mix as f64*purity;confidence+=mix*(hr.clamp(0.0,1.0)-1.0);}
                    let legacy_candidate=resident_halation_extract::smoothstep_f64(lower as f64,candidate_end as f64,legacy)*a;let red_candidate=resident_halation_extract::smoothstep_f64(lower as f64,candidate_end as f64,red)*confidence*a;let candidate=legacy_candidate+(red_candidate-legacy_candidate)*bias as f64;let sup=*support.add(i)as f64;let eligibility=if params.interior_protection>0.0{confidence}else{1.0};let authorized=candidate*sup*eligibility;let grown=authorized*params.source_expansion as f64*0.42;*weight.add(i)=(*weight.add(i)).max(grown as f32);if params.interior_protection>0.0{*authorization.add(i)=authorized as f32;}*sr.add(i)=(*sr.add(i)).max(grown as f32);*sg.add(i)=(*sg.add(i)).max((grown*(0.12+0.12*sup))as f32);}
                result.reads=(count*11)as u32;result.writes=(count*4)as u32;
            }
            PointKind::HalationAmplify(params) => {
                let sr=plane_mut_ptr(state,Plane::Scratch(5*n),n)?;let sg=plane_mut_ptr(state,Plane::Scratch(6*n),n)?;let sb=plane_mut_ptr(state,Plane::Scratch(7*n),n)?;let weight=plane_mut_ptr(state,Plane::Scratch(2*n),n)?;let a=params.amplify.clamp(0.0,4.0);let ga=if a<=1.0{a}else{1.0+(a-1.0)*0.55};let ba=if a<=1.0{a}else{1.0+(a-1.0)*0.15};for i in self.index..self.index+count{*sr.add(i)*=a;*sg.add(i)*=ga;*sb.add(i)*=ba;*weight.add(i)*=a;}result.reads=(count*4)as u32;result.writes=(count*4)as u32;
            }
            PointKind::HalationScaleDiffuse { channel, factor } => {let plane=plane_mut_ptr(state,Plane::Scratch((8+channel)*n),n)?;for i in self.index..self.index+count{*plane.add(i)*=factor;}result.reads=count as u32;result.writes=count as u32;}
            PointKind::HalationDensityGate(params) => {let sr=plane_ptr(state,Plane::Scratch(5*n),n)?;let envelope=plane_ptr(state,Plane::Scratch(17*n),n)?;let density=plane_mut_ptr(state,Plane::Scratch(2*n),n)?;let normalize=params.amplify.max(1.0);for i in self.index..self.index+count{let body=resident_smoothstep(0.015,0.08,(*sr.add(i)).max(*envelope.add(i))/normalize);*density.add(i)=1.0-params.interior_protection*body;}result.reads=(count*2)as u32;result.writes=count as u32;}
            PointKind::HalationPotential(params) => {
                let input=frame_ptr(state,params.input,values)?;let output=frame_mut_ptr(state,params.output,values)?;let local=plane_ptr(state,Plane::Scratch(n),n)?;let density=plane_mut_ptr(state,Plane::Scratch(2*n),n)?;let exposure=plane_ptr(state,Plane::Scratch(3*n),n)?;let auth=plane_ptr(state,Plane::Scratch(4*n),n)?;let sr=plane_ptr(state,Plane::Scratch(5*n),n)?;let sg=plane_ptr(state,Plane::Scratch(6*n),n)?;let sb=plane_ptr(state,Plane::Scratch(7*n),n)?;let diffuse=plane_ptr(state,Plane::Scratch(8*n),values)?;let envelope=plane_ptr(state,Plane::Scratch(17*n),n)?;let environment=plane_ptr(state,Plane::Scratch(18*n),n)?;let luminance=plane_ptr(state,Plane::Scratch(0),n)?;
                for i in self.index..self.index+count{let p=i*3;let hot=resident_smoothstep(params.hot_threshold-0.25,params.hot_threshold+0.25,*exposure.add(i));let attenuation=params.center_attenuation*(1.0-hot+hot*(1.0-params.hot_core_strength).powi(3));let legacy=[(*diffuse.add(i)-attenuation**sr.add(i)).max(0.0),(*diffuse.add(n+i)-attenuation**sg.add(i)).max(0.0),(*diffuse.add(2*n+i)-attenuation**sb.add(i)).max(0.0)];let mut potential=legacy;let gate_relief;
                    if params.interior_protection>0.0{let peak=*sr.add(i);let ratio=if peak>1e-8{(*envelope.add(i)/peak).min(1.0)}else{1.0};let dark=1.0-resident_smoothstep(0.32,0.62,*environment.add(i));let compact=1.0-resident_smoothstep(0.22,0.72,ratio);let authorization=(hot*compact).max((*auth.add(i)).clamp(0.0,1.0));let body=resident_smoothstep(0.04,0.42,*exposure.add(i));let gate_compact=authorization*dark;let effective=params.interior_protection*(1.0-gate_compact*(1.0-body));let edge=[(*diffuse.add(i)-params.redshift[0]**sr.add(i)).max(0.0),(*diffuse.add(n+i)-params.redshift[1]**sg.add(i)).max(0.0),(*diffuse.add(2*n+i)-params.redshift[2]**sb.add(i)).max(0.0)];for c in 0..3{potential[c]=legacy[c]*(1.0-effective)+edge[c]*effective;}let legacy_relief=(hot*params.hot_core_strength).max((1.0-resident_fast_exp(-legacy[0]*48.0))*params.hot_core_strength);let reflective=resident_smoothstep(0.45,0.72,*luminance.add(i))*resident_smoothstep(0.38,0.68,*environment.add(i));let edge_relief=(1.0-resident_fast_exp(-edge[0]*48.0))*params.hot_core_strength*(1.0-reflective);let gate_protection=params.interior_protection*(1.0-gate_compact);gate_relief=legacy_relief*(1.0-gate_protection)+edge_relief*gate_protection;}else{gate_relief=(hot*params.hot_core_strength).max((1.0-resident_fast_exp(-potential[0]*48.0))*params.hot_core_strength);}
                    let gate=*local.add(i)+(1.0-*local.add(i))*gate_relief;let mut preserve=0.0;if params.interior_protection>0.0&&params.spectral_sensitivity>0.0{let r=(*input.add(p)).max(0.0);let g=(*input.add(p+1)).max(0.0);let b=(*input.add(p+2)).max(0.0);let(sat,red,_,_)=resident_halation_extract::spectral_hue_response(r as f64,g as f64,b as f64);preserve=resident_smoothstep(0.35,0.80,sat as f32)*(1.0-resident_smoothstep(0.02,0.25,(red as f32).clamp(0.0,1.0)))*resident_smoothstep(0.28,0.72,r.max(g).max(b))*resident_smoothstep(0.0,1.0,params.spectral_sensitivity);}let target=gate*(1.0-preserve);for c in 0..3{*output.add(p+c)=potential[c]*target;}if params.color_density>0.0&&params.interior_protection<=0.0{*density.add(i)=1.0;}}
                result.reads=(count*24)as u32;result.writes=(count*(3+usize::from(params.color_density>0.0&&params.interior_protection<=0.0)))as u32;
            }
            PointKind::HalationGlobalSource(params) => {let exposure=plane_ptr(state,Plane::Scratch(3*n),n)?;let sr=plane_ptr(state,Plane::Scratch(5*n),n)?;let sg=plane_ptr(state,Plane::Scratch(6*n),n)?;let source=plane_mut_ptr(state,Plane::Scratch(8*n),n)?;for i in self.index..self.index+count{let gate=resident_smoothstep(params.global_source_threshold-0.25,params.global_source_threshold+0.25,*exposure.add(i));*source.add(i)=(*sr.add(i)*0.88+*sg.add(i)*0.12)*gate;}result.reads=(count*3)as u32;result.writes=count as u32;}
            PointKind::HalationGlobalAdd(params) => {let output=frame_mut_ptr(state,params.output,values)?;let luminance=plane_ptr(state,Plane::Scratch(0),n)?;let global=plane_ptr(state,Plane::Scratch(9*n),n)?;for i in self.index..self.index+count{let y=(*luminance.add(i)).max(0.0);let gate=resident_smoothstep(0.03,0.3,y)*(1.0-resident_smoothstep(0.75,1.8,y));let aggregate=(1.0-resident_fast_exp(-(*global.add(i)).max(0.0)*0.75))/0.75;let value=aggregate*params.global_diffusion*gate;let p=i*3;*output.add(p)+=value;*output.add(p+1)+=value*0.12;*output.add(p+2)+=value*0.025;}result.reads=(count*5)as u32;result.writes=(count*3)as u32;}
            PointKind::HalationComposite(params) => {let input=frame_ptr(state,params.input,values)?;let output=frame_mut_ptr(state,params.output,values)?;let density=plane_ptr(state,Plane::Scratch(2*n),n)?;let effect=params.strength/100.0*2.0;for i in self.index..self.index+count{let p=i*3;let r=*input.add(p);let g=*input.add(p+1);let b=*input.add(p+2);let gains=if params.screen{[halation_screen_gain(r),halation_screen_gain(g),halation_screen_gain(b)]}else{[1.0;3]};let er=(*output.add(p)).max(0.0)*effect*gains[0];let eg=(*output.add(p+1)).max(0.0)*effect*gains[1];let eb=(*output.add(p+2)).max(0.0)*effect*gains[2];let density_value=if params.color_density>0.0{*density.add(i)}else{1.0};let effected=halation_density_composite(r,g,b,er,eg,eb,params.color_density.clamp(0.0,1.0)*density_value,params.blue_compensation.clamp(0.0,1.0));let coverage=resident_mask_coverage(params.mask,r,g,b);let final_rgb=finite_rgb([apply_masked_effect(r,effected[0],coverage,params.mask.enabled),apply_masked_effect(g,effected[1],coverage,params.mask.enabled),apply_masked_effect(b,effected[2],coverage,params.mask.enabled)])?;for c in 0..3{*output.add(p+c)=final_rgb[c];}}result.reads=(count*(9+usize::from(params.color_density>0.0)))as u32;result.writes=(count*3)as u32;}
            PointKind::GrainInit(_params) => {let accum=plane_mut_ptr(state,Plane::Scratch(0),values)?;for i in self.index..self.index+count{for c in 0..3{*accum.add(c*n+i)=0.0;}}result.writes=(count*3)as u32;}
            PointKind::GrainGenerate { params, scale } => {
                let fields=plane_mut_ptr(state,Plane::Scratch(3*n),params.field_pixels*4)?;
                for i in self.index..self.index+count {
                    let y=i/params.field_width;
                    let x=i%params.field_width;
                    let absolute_y=match params.exact_stride {
                        Some(stride)=>params.exact_origin_y.wrapping_add((y as i32).wrapping_mul(stride)),
                        None=>(params.field_origin_y+y as f32/params.field_preview_scale).floor()as i32,
                    };
                    let absolute_x=match params.exact_stride {
                        Some(stride)=>params.exact_origin_x.wrapping_add((x as i32).wrapping_mul(stride)),
                        None=>(params.field_origin_x+x as f32/params.field_preview_scale).floor()as i32,
                    };
                    let prefix=hash_coordinate_prefix_from_node(params.node_prefix,absolute_x,absolute_y,scale as u32);
                    #[cfg(all(feature = "simd", target_arch = "wasm32"))]
                    {
                        let generated=gaussian_channels_simd(prefix);
                        for c in 0..4 {*fields.add(c*params.field_pixels+i)=generated[c];}
                    }
                    #[cfg(not(all(feature = "simd", target_arch = "wasm32")))]
                    for c in 0..4 {*fields.add(c*params.field_pixels+i)=gaussian_from_channel_prefix(prefix,c as u32);}
                }
                result.writes=(count*4)as u32;
            }
            PointKind::GrainAccumulate { params, shared, independent } => {let fields=plane_ptr(state,Plane::Scratch(3*n),params.field_pixels*4)?;let accum=plane_mut_ptr(state,Plane::Scratch(0),values)?;for i in self.index..self.index+count{let y=i/state.width;let x=i%state.width;let mut sampled=[0.0;4];if params.field_scale==1{let fi=(y+params.max_pad)*params.field_width+x+params.max_pad;for c in 0..4{sampled[c]=*fields.add(c*params.field_pixels+fi);}}else{let inv=1.0/params.field_scale as f32;let fy=((y as f32+0.5)*inv-0.5+params.max_pad as f32).clamp(0.0,(params.field_height-1)as f32);let fx=((x as f32+0.5)*inv-0.5+params.max_pad as f32).clamp(0.0,(params.field_width-1)as f32);let y0=fy.floor()as usize;let y1=(y0+1).min(params.field_height-1);let x0=fx.floor()as usize;let x1=(x0+1).min(params.field_width-1);let ty=fy-y0 as f32;let tx=fx-x0 as f32;for c in 0..4{let base=c*params.field_pixels;let top=*fields.add(base+y0*params.field_width+x0)+(*fields.add(base+y0*params.field_width+x1)-*fields.add(base+y0*params.field_width+x0))*tx;let bottom=*fields.add(base+y1*params.field_width+x0)+(*fields.add(base+y1*params.field_width+x1)-*fields.add(base+y1*params.field_width+x0))*tx;sampled[c]=top+(bottom-top)*ty;}}let common=sampled[0]*shared;*accum.add(i)+=common+sampled[1]*independent;*accum.add(n+i)+=common+sampled[2]*independent;*accum.add(2*n+i)+=common+sampled[3]*independent;}result.reads=(count*19)as u32;result.writes=(count*3)as u32;}
            PointKind::GrainComposite(params) => {let input=frame_ptr(state,params.input,values)?;let output=frame_mut_ptr(state,params.output,values)?;let accum=plane_ptr(state,Plane::Scratch(0),values)?;for i in self.index..self.index+count{let p=i*3;let originals=[*input.add(p),*input.add(p+1),*input.add(p+2)];let lum=(0.2126*originals[0]+0.7152*originals[1]+0.0722*originals[2]).max(1e-6);let exposure=resident_fast_log2(lum/0.18);let envelope=if params.positive{0.35+0.75*resident_fast_exp(-0.5*((exposure-0.3)/1.4).powi(2))}else{0.42+0.58*resident_fast_exp(-0.5*((exposure+0.5)/2.0).powi(2))};let sigma_d=0.085*params.amount*(params.iso/250.0).sqrt()*envelope;let variance=(std::f32::consts::LN_2*sigma_d).powi(2);let coverage=resident_mask_coverage(params.mask,originals[0],originals[1],originals[2]);let mut final_rgb=[0.0;3];for c in 0..3{let original=originals[c];let log_gain=(std::f32::consts::LN_2*sigma_d**accum.add(c*n+i)-0.5*variance).clamp(-20.0,20.0);let gain=resident_fast_exp(log_gain);let grained=original+state.alpha[i]*(original*gain-original);final_rgb[c]=apply_masked_effect(original,grained,coverage,params.mask.enabled);}let final_rgb=finite_rgb(final_rgb)?;for c in 0..3{*output.add(p+c)=final_rgb[c];}}result.reads=(count*7)as u32;result.writes=(count*3)as u32;}
        }
        self.index += count; result.work=count as u32; result.done=self.index==self.total;
        Ok(result)
    }
}

struct ValidateOp { meta: StepMeta, physical: usize, index: usize }

enum KernelOp { Point(PointOp), Blur(BlurOp), MaxFilter(MaxFilterOp), Validate(ValidateOp) }

impl KernelOp {
    fn meta(&self) -> StepMeta { match self { Self::Point(op)=>op.meta, Self::Blur(op)=>op.meta, Self::MaxFilter(op)=>op.meta, Self::Validate(op)=>op.meta } }
    fn pass(&self)->u32 { match self {
        Self::Point(op)=>op.meta.pass, Self::Validate(op)=>op.meta.pass,
        Self::MaxFilter(op)=>if matches!(op.direction,MaxDirection::Horizontal){0}else{1},
        Self::Blur(op)=>match op.stage {
            BlurStage::Downsample=>0, BlurStage::Commit=>15, BlurStage::Done=>16,
            BlurStage::Filter=>match op.filter.as_ref().map(|value|&value.stage) {
                None=>1, Some(FilterStage::Copy{..})=>1, Some(FilterStage::GaussianInit{..})=>1,
                Some(FilterStage::GaussianNormalize{..})=>2, Some(FilterStage::GaussianHorizontal{..})=>3,
                Some(FilterStage::GaussianVertical{..})=>4, Some(FilterStage::BoxInit{pass,vertical,..})|Some(FilterStage::BoxRun{pass,vertical,..})=>(*pass*2+usize::from(*vertical)+1)as u32,
                Some(FilterStage::VvFill{axis,..})=>1+*axis as u32*4, Some(FilterStage::VvForward{axis,..})=>2+*axis as u32*4,
                Some(FilterStage::VvBackward{axis,..})=>3+*axis as u32*4, Some(FilterStage::VvWrite{axis,..})=>4+*axis as u32*4,
                Some(FilterStage::VvVerticalFill{..})=>5, Some(FilterStage::VvVerticalForward{..})=>6,
                Some(FilterStage::VvVerticalBackward{..})=>7, Some(FilterStage::VvVerticalWrite{..})=>8,
                Some(FilterStage::Done)=>14,
            }
        }
    }}
    unsafe fn step(&mut self, state: &mut ResidentState, budget: usize) -> Result<KernelStep,i32> {
        match self {
            Self::Point(op)=>op.step(state,budget), Self::Blur(op)=>op.step(state,budget), Self::MaxFilter(op)=>op.step(state,budget),
            Self::Validate(op)=>{let total=state.width*state.height*3;let count=budget.min(total.saturating_sub(op.index));let source=frame_ptr(state,op.physical,total)?;for i in op.index..op.index+count{if !(*source.add(i)).is_finite(){return Err(ERR_NONFINITE_OUTPUT)}}op.index+=count;Ok(KernelStep{work:count as u32,reads:count as u32,done:op.index==total,..KernelStep::default()})}
        }
    }
}

pub(super) struct NodeKernel {
    cursor: KernelCursor,
    ops: Vec<KernelOp>,
    op_index: usize,
    identity: bool,
    output_physical: usize,
    bloom_base_on_commit: Option<usize>,
    bloom_fusion_on_commit: Option<BloomParams>,
}

pub(super) enum ActiveKernel {
    Identity(NodeKernel), Defringe(NodeKernel), Bloom(NodeKernel), HighlightProtection(NodeKernel),
    Halation(NodeKernel), Resolution(NodeKernel), Grain(NodeKernel),
}

impl ActiveKernel {
    fn node(&self)->&NodeKernel { match self { Self::Identity(v)|Self::Defringe(v)|Self::Bloom(v)|Self::HighlightProtection(v)|Self::Halation(v)|Self::Resolution(v)|Self::Grain(v)=>v } }
    fn node_mut(&mut self)->&mut NodeKernel { match self { Self::Identity(v)|Self::Defringe(v)|Self::Bloom(v)|Self::HighlightProtection(v)|Self::Halation(v)|Self::Resolution(v)|Self::Grain(v)=>v } }
    pub(super) fn cursor(&self)->KernelCursor { self.node().cursor }
    pub(super) fn identity(&self)->bool { self.node().identity }
    pub(super) fn output_physical(&self)->usize { self.node().output_physical }
    pub(super) fn bloom_base_on_commit(&self)->Option<usize> { self.node().bloom_base_on_commit }
    pub(super) fn bloom_fusion_on_commit(&self)->Option<BloomParams> { self.node().bloom_fusion_on_commit }
}

fn scaled_algorithm(fast: bool, sigma: f32, scale: usize)->BlurAlgorithm {
    if fast { BlurAlgorithm::Box3 } else if sigma / (scale.max(1) as f32) < 0.4 { BlurAlgorithm::Gaussian } else { BlurAlgorithm::VanVliet }
}

fn base_kernel(cursor: KernelCursor, output_physical: usize, identity: bool, mut ops: Vec<KernelOp>)->NodeKernel {
    // Pointwise terminal operations validate before publishing their writes,
    // so a second full-frame read is unnecessary. Identity nodes still scan
    // their aliased input because they have no terminal writer of their own.
    if identity { let meta=ops.last().map(KernelOp::meta).unwrap_or(StepMeta::new(0));ops.push(KernelOp::Validate(ValidateOp{meta,physical:output_physical,index:0})); }
    NodeKernel { cursor,ops,op_index:0,identity,output_physical,bloom_base_on_commit:None,bloom_fusion_on_commit:None }
}

fn fused_alias_kernel(cursor: KernelCursor, input_physical: usize, ops: Vec<KernelOp>)->NodeKernel {
    NodeKernel { cursor,ops,op_index:0,identity:true,output_physical:input_physical,bloom_base_on_commit:None,bloom_fusion_on_commit:None }
}

pub(super) fn activate_kernel(state:&mut ResidentState,node:usize,node_hash:u32,opcode:u16,input_slot:usize,output_slot:usize,params_start:usize,params_end:usize)->Result<ActiveKernel,i32>{
    let command=&state.command[..state.command_len];
    let input_physical=state.logical_frames[input_slot.min(1)] as usize;
    let output_physical=1-input_physical;
    let cursor=KernelCursor{node,node_hash,opcode,input_slot,output_slot,phase:0,channel:0,lobe:0,pass:0,row:0,column:0,index:0};
    let n=state.width*state.height;let width=state.width;let height=state.height;
    let mask=resident_mask(command,params_start,params_end)?;
    match opcode {
        10=>{
            let amount=object_f32(command,params_start,params_end,HASH_AMOUNT).ok_or(ERR_NONFINITE_PARAM)?;let radius_px=object_f32(command,params_start,params_end,HASH_RADIUS_PX).ok_or(ERR_NONFINITE_PARAM)?;let threshold=object_f32(command,params_start,params_end,HASH_THRESHOLD).ok_or(ERR_NONFINITE_PARAM)?;let softness=object_f32(command,params_start,params_end,HASH_SOFTNESS).ok_or(ERR_NONFINITE_PARAM)?;let edge=object_f32(command,params_start,params_end,HASH_EDGE_SENSITIVITY).ok_or(ERR_NONFINITE_PARAM)?;
            if [amount,radius_px,threshold,softness,edge].iter().any(|v|!v.is_finite()){return Err(ERR_NONFINITE_PARAM)}
            if amount==0.0||edge==0.0{return Ok(ActiveKernel::Identity(base_kernel(cursor,input_physical,true,Vec::new())))}
            if state.scratch.len()<n*7{return Err(ERR_CAPACITY)} let preview=f32::from_le_bytes(command[44..48].try_into().unwrap());let fast=u32::from_le_bytes(command[48..52].try_into().unwrap())==0;let sigma=(radius_px*preview.max(0.01)).max(0.05);let params=DefringeParams{input:input_physical,output:output_physical,amount,threshold,softness,edge_sensitivity:edge,mask};let ws_y=BlurWorkspace{work_out:Plane::Scratch(2*n),temp_a:Plane::Scratch(4*n),temp_b:Plane::Scratch(5*n),low_src:Plane::Scratch(4*n),low_dst:Plane::Scratch(2*n),low_temp_a:Plane::Scratch(4*n),low_temp_b:Plane::Scratch(5*n)};let ws_cg=BlurWorkspace{work_out:Plane::Scratch(3*n),..ws_y};
            let ops=vec![KernelOp::Point(PointOp::new(StepMeta::new(0),PointKind::DefringeExtract(params),n)),
                KernelOp::Blur(BlurOp::new(StepMeta::new(1),Plane::Scratch(0),BlurDestination::Replace(Plane::Scratch(2*n),1.0),ws_y,width,height,sigma,1,if fast{BlurAlgorithm::Box3}else{BlurAlgorithm::Gaussian})),
                KernelOp::Blur(BlurOp::new(StepMeta::new(2),Plane::Scratch(n),BlurDestination::Replace(Plane::Scratch(3*n),1.0),ws_cg,width,height,sigma,1,if fast{BlurAlgorithm::Box3}else{BlurAlgorithm::Gaussian})),
                KernelOp::Point(PointOp::new(StepMeta::new(3),PointKind::DefringeComposite(params),n))];
            Ok(ActiveKernel::Defringe(base_kernel(cursor,output_physical,false,ops)))
        }
        40=>{
            let threshold_ev=object_f32(command,params_start,params_end,HASH_THRESHOLD_EV).ok_or(ERR_NONFINITE_PARAM)?;let softness_ev=object_f32(command,params_start,params_end,HASH_SOFTNESS_EV).ok_or(ERR_NONFINITE_PARAM)?;let radius=object_f32(command,params_start,params_end,HASH_RADIUS).ok_or(ERR_NONFINITE_PARAM)?;let amplify=object_f32(command,params_start,params_end,HASH_AMPLIFY).ok_or(ERR_NONFINITE_PARAM)?;let saturation=object_f32(command,params_start,params_end,HASH_SATURATION).ok_or(ERR_NONFINITE_PARAM)?;let save_lights=object_f32(command,params_start,params_end,HASH_SAVE_LIGHTS).ok_or(ERR_NONFINITE_PARAM)?;
            if [threshold_ev,softness_ev,radius,amplify,saturation,save_lights].iter().any(|v|!v.is_finite()){return Err(ERR_NONFINITE_PARAM)}
            if amplify==0.0{return Ok(ActiveKernel::Identity(base_kernel(cursor,input_physical,true,Vec::new())))}
            if state.scratch.len()<n*10||state.transient.len()<n*3{return Err(ERR_CAPACITY)} let full_width=u32::from_le_bytes(command[28..32].try_into().unwrap())as f32;let full_height=u32::from_le_bytes(command[32..36].try_into().unwrap())as f32;let preview=f32::from_le_bytes(command[44..48].try_into().unwrap());let fast=u32::from_le_bytes(command[48..52].try_into().unwrap())==0;let threshold=0.18*2.0_f32.powf(threshold_ev);let gate_end=threshold*2.0_f32.powf(softness_ev);let radius_px=radius*0.01*full_width.hypot(full_height)*preview;let params=BloomParams{input:input_physical,output:output_physical,threshold,gate_end,amplify,saturation,save_lights,mask};let ws=BlurWorkspace{work_out:Plane::Scratch(3*n),temp_a:Plane::Scratch(4*n),temp_b:Plane::Scratch(5*n),low_src:Plane::Scratch(6*n),low_dst:Plane::Scratch(7*n),low_temp_a:Plane::Scratch(8*n),low_temp_b:Plane::Scratch(9*n)};
            let mut ops=vec![KernelOp::Point(PointOp::new(StepMeta::new(0),PointKind::BloomExtract(params),n))];let ratios=[0.22,0.75,2.4];let weights=[0.62,0.28,0.10];
            for channel in 0..3{let mut previous_scale=0usize;for lobe in 0..3{let sigma=(radius_px*ratios[lobe]).max(0.05);let scale=bloom_lobe_scale(sigma,lobe);let mut blur=BlurOp::new(StepMeta::diffuse(1,channel,lobe),Plane::Scratch(channel*n),BlurDestination::AccumulateInterleaved{plane:Plane::Transient(0),channel,weight:weights[lobe]},ws,width,height,sigma,scale,scaled_algorithm(fast,sigma,scale));if scale>1&&scale==previous_scale{blur=blur.with_reused_downsample();}ops.push(KernelOp::Blur(blur));previous_scale=scale;}}
            let fuse_highlight=state.segmented&&!state.debug_intermediates&&node+1<state.node_count&&command_node_record(command,node+1).map(|record|record.0==50).unwrap_or(false);let mut kernel=if fuse_highlight{let mut value=fused_alias_kernel(cursor,input_physical,ops);value.bloom_fusion_on_commit=Some(params);value}else{ops.push(KernelOp::Point(PointOp::new(StepMeta::new(2),PointKind::BloomComposite(params),n)));base_kernel(cursor,output_physical,false,ops)};kernel.bloom_base_on_commit=Some(input_physical);Ok(ActiveKernel::Bloom(kernel))
        }
        50=>{
            let amount=object_f32(command,params_start,params_end,HASH_AMOUNT).ok_or(ERR_NONFINITE_PARAM)?;let threshold_ev=object_f32(command,params_start,params_end,HASH_THRESHOLD_EV).ok_or(ERR_NONFINITE_PARAM)?;let softness_ev=object_f32(command,params_start,params_end,HASH_SOFTNESS_EV).ok_or(ERR_NONFINITE_PARAM)?;if [amount,threshold_ev,softness_ev].iter().any(|v|!v.is_finite()){return Err(ERR_NONFINITE_PARAM)}let fused_bloom=state.pending_bloom_fusion.take();if amount==0.0&&fused_bloom.is_none(){return Ok(ActiveKernel::Identity(base_kernel(cursor,input_physical,true,Vec::new())))}
            let threshold=0.18*2.0_f32.powf(threshold_ev);let missing=fused_bloom.is_none()&&(state.bloom_base_slot<0||!state.bloom_contribution_valid);if missing{state.stats[4]=1;}let base=if missing{input_physical}else{state.bloom_base_slot as usize};let params=HighlightParams{input:input_physical,output:output_physical,base,amount,threshold,gate_end:threshold*2.0_f32.powf(softness_ev),mask,missing};let(kind,total,pass)=if let Some(bloom)=fused_bloom{state.fusion_count=state.fusion_count.saturating_add(1);(PointKind::FusedBloomHighlight{bloom,highlight:params},n,31)}else{(PointKind::HighlightProtect(params),if missing{n*3}else{n},0)};let ops=vec![KernelOp::Point(PointOp::new(StepMeta{phase:0,channel:0,lobe:0,pass},kind,total))];Ok(ActiveKernel::HighlightProtection(base_kernel(cursor,output_physical,false,ops)))
        }
        60=>{
            let amount=object_f32(command,params_start,params_end,HASH_AMOUNT).ok_or(ERR_NONFINITE_PARAM)?;let response=object_f32(command,params_start,params_end,HASH_RESPONSE).ok_or(ERR_NONFINITE_PARAM)?;let toe_loss=object_f32(command,params_start,params_end,HASH_TOE_LOSS).ok_or(ERR_NONFINITE_PARAM)?;let shoulder_loss=object_f32(command,params_start,params_end,HASH_SHOULDER_LOSS).ok_or(ERR_NONFINITE_PARAM)?;if [amount,response,toe_loss,shoulder_loss].iter().any(|v|!v.is_finite()){return Err(ERR_NONFINITE_PARAM)} if amount==0.0{return Ok(ActiveKernel::Identity(base_kernel(cursor,input_physical,true,Vec::new())))}
            if state.scratch.len()<n*6{return Err(ERR_CAPACITY)} let positive=object_string_eq(command,params_start,params_end,HASH_PROFILE,b"positive");let full_width=u32::from_le_bytes(command[28..32].try_into().unwrap())as f32;let preview=f32::from_le_bytes(command[44..48].try_into().unwrap());let quality=u32::from_le_bytes(command[48..52].try_into().unwrap());let format=u32::from_le_bytes(command[56..60].try_into().unwrap());let iso=u32::from_le_bytes(command[60..64].try_into().unwrap()).max(1)as f32;let aperture=match format{1=>5.79,2=>12.52,4=>52.15,_=>24.89};let base=if positive{42.0}else{56.0};let f50=(base*(250.0/iso).powf(0.10).clamp(0.75,1.25)*response).clamp(12.0,120.0);let sigma=(std::f32::consts::LN_2.sqrt()/(2.0_f32.sqrt()*std::f32::consts::PI*(f50/(full_width/aperture)).max(1e-4)))*preview;if sigma<0.15{return Ok(ActiveKernel::Identity(base_kernel(cursor,input_physical,true,Vec::new())))} let params=ResolutionParams{input:input_physical,output:output_physical,amount,toe_loss,shoulder_loss,mask};let ws=BlurWorkspace{work_out:Plane::Scratch(2*n),temp_a:Plane::Scratch(4*n),temp_b:Plane::Scratch(5*n),low_src:Plane::Scratch(4*n),low_dst:Plane::Scratch(2*n),low_temp_a:Plane::Scratch(4*n),low_temp_b:Plane::Scratch(5*n)};let algorithm=if quality==0{BlurAlgorithm::Box3}else{BlurAlgorithm::Gaussian};let mut ops=vec![KernelOp::Point(PointOp::new(StepMeta::new(0),PointKind::ResolutionWeights(params),n))];
            for channel in 0..3{ops.push(KernelOp::Point(PointOp::new(StepMeta{phase:1,channel:channel as u32,lobe:0,pass:0},PointKind::ResolutionExtract{params,channel},n)));ops.push(KernelOp::Blur(BlurOp::new(StepMeta{phase:2,channel:channel as u32,lobe:0,pass:0},Plane::Scratch(n),BlurDestination::Replace(Plane::Scratch(2*n),1.0),ws,width,height,sigma,1,algorithm)));let wide_ws=BlurWorkspace{work_out:Plane::Scratch(3*n),..ws};ops.push(KernelOp::Blur(BlurOp::new(StepMeta{phase:3,channel:channel as u32,lobe:0,pass:0},Plane::Scratch(n),BlurDestination::Replace(Plane::Scratch(3*n),1.0),wide_ws,width,height,sigma*2.2,1,algorithm)));ops.push(KernelOp::Point(PointOp::new(StepMeta{phase:4,channel:channel as u32,lobe:0,pass:0},PointKind::ResolutionComposite{params,channel},n)));}
            Ok(ActiveKernel::Resolution(base_kernel(cursor,output_physical,false,ops)))
        }
        30=>activate_halation(state,cursor,input_physical,output_physical,params_start,params_end,mask),
        70=>activate_grain(state,cursor,input_physical,output_physical,params_start,params_end,mask),
        _=>Err(ERR_UNSUPPORTED_NODE),
    }
}

pub(super) unsafe fn step_kernel(state:&mut ResidentState,kernel:&mut ActiveKernel,budget:usize)->Result<KernelStep,i32>{
    let node=kernel.node_mut();
    if node.op_index>=node.ops.len(){return Ok(KernelStep{done:true,..KernelStep::default()})}
    let first_meta=node.ops[node.op_index].meta();
    node.cursor.phase=first_meta.phase;node.cursor.channel=first_meta.channel;node.cursor.lobe=first_meta.lobe;node.cursor.pass=node.ops[node.op_index].pass();
    // Consume as much of the caller's budget as possible, but only while the
    // next primitive belongs to this same semantic phase.  This keeps the
    // phase boundary observable between calls without paying one host call
    // for every small primitive (for example each channel/lobe blur).
    let mut remaining=budget.max(1);
    let mut combined=KernelStep::default();
    let mut transitions=0usize;
    let mut cursor_index=0usize;
    loop {
        let meta=node.ops[node.op_index].meta();
        if meta.phase!=first_meta.phase { break; }
        node.cursor.phase=meta.phase;node.cursor.channel=meta.channel;node.cursor.lobe=meta.lobe;node.cursor.pass=node.ops[node.op_index].pass();
        let result=node.ops[node.op_index].step(state,remaining)?;
        combined.work=combined.work.saturating_add(result.work);combined.reads=combined.reads.saturating_add(result.reads);combined.writes=combined.writes.saturating_add(result.writes);combined.taps=combined.taps.saturating_add(result.taps);combined.downsample_pixels=combined.downsample_pixels.saturating_add(result.downsample_pixels);combined.upsample_pixels=combined.upsample_pixels.saturating_add(result.upsample_pixels);
        remaining=remaining.saturating_sub(result.work as usize);
        if result.done {
            cursor_index=0;
            node.op_index+=1;
            if node.op_index==node.ops.len() { combined.done=true; break; }
            // Stop before the next phase.  A same-phase operation can be
            // entered immediately, retaining the bounded work budget.
            if node.ops[node.op_index].meta().phase!=first_meta.phase { break; }
            if remaining==0 { break; }
            transitions=0;
        } else if result.work==0 {
            cursor_index=cursor_index.saturating_add(result.work as usize);
            transitions+=1;
            if transitions>32{return Err(ERR_INTERNAL)}
            if remaining==0 { break; }
        } else {
            cursor_index=cursor_index.saturating_add(result.work as usize);
            transitions=0;
            if remaining==0 { break; }
        }
    }
    node.cursor.index=cursor_index;
    node.cursor.row=(node.cursor.index/state.width.max(1)).min(state.height.saturating_sub(1))as u32;
    node.cursor.column=(node.cursor.index%state.width.max(1))as u32;
    if combined.done { node.cursor.index=0; }
    Ok(combined)
}

fn activate_halation(state:&mut ResidentState,cursor:KernelCursor,input:usize,output:usize,params_start:usize,params_end:usize,mask:ResidentMask)->Result<ActiveKernel,i32>{
    let command=&state.command[..state.command_len];macro_rules! value{($hash:expr)=>{object_f32(command,params_start,params_end,$hash).ok_or(ERR_NONFINITE_PARAM)?};}
    let strength=value!(HASH_STRENGTH);let sigma=value!(HASH_SIGMA);let threshold=value!(HASH_THRESHOLD);let source_softness=value!(HASH_SOURCE_SOFTNESS);let background_threshold=value!(HASH_BACKGROUND_THRESHOLD);let background_softness=value!(HASH_BACKGROUND_SOFTNESS);let smoothness=value!(HASH_SMOOTHNESS);let source_impact=value!(HASH_SOURCE_IMPACT);let amplify=value!(HASH_AMPLIFY);let source_expansion=value!(HASH_SOURCE_EXPANSION);let red_tail=value!(HASH_RED_TAIL);let blue_compensation=value!(HASH_BLUE_COMPENSATION);let color_density=value!(HASH_COLOR_DENSITY);let interior_protection=value!(HASH_SOURCE_INTERIOR_PROTECTION);let hot_threshold=value!(HASH_HOT_SOURCE_THRESHOLD);let hot_core_strength=value!(HASH_HOT_CORE_STRENGTH);let global_source_threshold=value!(HASH_GLOBAL_SOURCE_THRESHOLD);let spectral_sensitivity=value!(HASH_SPECTRAL_SENSITIVITY);let red_layer_bias=value!(HASH_RED_LAYER_THRESHOLD_BIAS);let global_diffusion=value!(HASH_GLOBAL_DIFFUSION);let center_attenuation=value!(HASH_CENTER_ATTENUATION);let spill_mix=value!(HASH_SPILL_MIX);let redshift=object_array3_f32(command,params_start,params_end,HASH_REDSHIFT).ok_or(ERR_NONFINITE_PARAM)?;let sigma_ratio=object_array3_f32(command,params_start,params_end,HASH_SIGMA_RATIO).ok_or(ERR_NONFINITE_PARAM)?;
    let scalars=[strength,sigma,threshold,source_softness,background_threshold,background_softness,smoothness,source_impact,amplify,source_expansion,red_tail,blue_compensation,color_density,interior_protection,hot_threshold,hot_core_strength,global_source_threshold,spectral_sensitivity,red_layer_bias,global_diffusion,center_attenuation,spill_mix];if scalars.iter().chain(redshift.iter()).chain(sigma_ratio.iter()).any(|v|!v.is_finite()){return Err(ERR_NONFINITE_PARAM)} if strength==0.0{return Ok(ActiveKernel::Identity(base_kernel(cursor,input,true,Vec::new())))}
    let n=state.width*state.height;if state.scratch.len()<n*19{return Err(ERR_CAPACITY)}let fast=object_string_eq(command,params_start,params_end,HASH_DIFFUSION_MODE,b"fast");let spill=object_string_eq(command,params_start,params_end,HASH_EXTRACTION,b"spill");let screen=object_string_eq(command,params_start,params_end,HASH_BLEND_MODE,b"screen");let params=HalationParams{input,output,strength,threshold,source_softness,background_threshold,background_softness,source_impact,amplify,source_expansion,blue_compensation,color_density,interior_protection,hot_threshold,hot_core_strength,global_source_threshold,spectral_sensitivity,red_layer_bias,global_diffusion,center_attenuation,spill_mix:if spill{spill_mix}else{0.0},redshift,screen,mask};
    let width=state.width;let height=state.height;let ws=BlurWorkspace{work_out:Plane::Scratch(17*n),temp_a:Plane::Scratch(11*n),temp_b:Plane::Scratch(12*n),low_src:Plane::Scratch(13*n),low_dst:Plane::Scratch(14*n),low_temp_a:Plane::Scratch(15*n),low_temp_b:Plane::Scratch(16*n)};
    let mut ops=vec![KernelOp::Point(PointOp::new(StepMeta::new(0),PointKind::HalationExtract(params),n))];
    if source_expansion>0.0{ops.push(KernelOp::Point(PointOp::new(StepMeta::new(1),PointKind::HalationExpansionSeed(params),n)));let radius=(sigma.max(0.5)*(0.45+0.85*source_expansion)).ceil().max(1.0)as usize;ops.push(KernelOp::MaxFilter(MaxFilterOp::new(StepMeta::new(1),Plane::Scratch(4*n),Plane::Scratch(8*n),Plane::Scratch(9*n),width,height,radius)));ops.push(KernelOp::Point(PointOp::new(StepMeta::new(1),PointKind::HalationExpansionApply(params),n)));}
    if amplify!=1.0{ops.push(KernelOp::Point(PointOp::new(StepMeta::new(1),PointKind::HalationAmplify(params),n)));}
    for channel in 0..3{let channel_sigma=sigma*sigma_ratio[channel];let lobes=halation_lobes(smoothness,red_tail,channel==0);let mut previous_scale=0usize;for (lobe,(ratio,weight)) in lobes.iter().copied().enumerate(){let lobe_sigma=channel_sigma*ratio;let scale=halation_scale(lobe_sigma,lobe==0,fast);let destination=if lobe==0{BlurDestination::Replace(Plane::Scratch((8+channel)*n),weight)}else{BlurDestination::Accumulate(Plane::Scratch((8+channel)*n),weight)};let mut blur=BlurOp::new(StepMeta::diffuse(2,channel,lobe),Plane::Scratch((5+channel)*n),destination,ws,width,height,lobe_sigma,scale,scaled_algorithm(fast,lobe_sigma,scale));if scale>1&&scale==previous_scale{blur=blur.with_reused_downsample();}ops.push(KernelOp::Blur(blur));previous_scale=scale;}ops.push(KernelOp::Point(PointOp::new(StepMeta::diffuse(2,channel,2),PointKind::HalationScaleDiffuse{channel,factor:redshift[channel]},n)));}
    if interior_protection>0.0{let envelope_sigma=(sigma*0.7).max(0.5);ops.push(KernelOp::Blur(BlurOp::new(StepMeta::new(3),Plane::Scratch(5*n),BlurDestination::Replace(Plane::Scratch(17*n),1.0),ws,width,height,envelope_sigma,1,scaled_algorithm(fast,envelope_sigma,1))));let context_sigma=(sigma*1.25).max(2.0);let scale=halation_scale(context_sigma,false,fast);let context_ws=BlurWorkspace{work_out:Plane::Scratch(18*n),..ws};ops.push(KernelOp::Blur(BlurOp::new(StepMeta::new(3),Plane::Scratch(0),BlurDestination::Replace(Plane::Scratch(18*n),1.0),context_ws,width,height,context_sigma,scale,scaled_algorithm(fast,context_sigma,scale))));if color_density>0.0{ops.push(KernelOp::Point(PointOp::new(StepMeta::new(3),PointKind::HalationDensityGate(params),n)));}}
    ops.push(KernelOp::Point(PointOp::new(StepMeta::new(3),PointKind::HalationPotential(params),n)));
    if global_diffusion>0.0{ops.push(KernelOp::Point(PointOp::new(StepMeta::new(4),PointKind::HalationGlobalSource(params),n)));let broad=(sigma*4.0).max(12.0);let scale=halation_scale(broad,false,fast);let global_ws=BlurWorkspace{work_out:Plane::Scratch(9*n),..ws};ops.push(KernelOp::Blur(BlurOp::new(StepMeta::new(4),Plane::Scratch(8*n),BlurDestination::Replace(Plane::Scratch(9*n),1.0),global_ws,width,height,broad,scale,scaled_algorithm(fast,broad,scale))));ops.push(KernelOp::Point(PointOp::new(StepMeta::new(4),PointKind::HalationGlobalAdd(params),n)));}
    ops.push(KernelOp::Point(PointOp::new(StepMeta::new(5),PointKind::HalationComposite(params),n)));
    Ok(ActiveKernel::Halation(base_kernel(cursor,output,false,ops)))
}

fn activate_grain(state:&mut ResidentState,cursor:KernelCursor,input:usize,output:usize,params_start:usize,params_end:usize,mask:ResidentMask)->Result<ActiveKernel,i32>{
    let command=&state.command[..state.command_len];let amount=object_f32(command,params_start,params_end,HASH_AMOUNT).ok_or(ERR_NONFINITE_PARAM)?;let size=object_f32(command,params_start,params_end,HASH_SIZE).ok_or(ERR_NONFINITE_PARAM)?;let roughness=object_f32(command,params_start,params_end,HASH_ROUGHNESS).ok_or(ERR_NONFINITE_PARAM)?;let chroma=object_f32(command,params_start,params_end,HASH_CHROMA).ok_or(ERR_NONFINITE_PARAM)?;let seed=object_u32(command,params_start,params_end,HASH_SEED).unwrap_or(0);let fast=object_string_eq(command,params_start,params_end,HASH_MODE,b"fast");let analogue=object_string_eq(command,params_start,params_end,HASH_MODE,b"analogue");if [amount,size,roughness,chroma].iter().any(|v|!v.is_finite())||(!fast&&!analogue){return Err(ERR_UNSUPPORTED_NODE)}if amount==0.0{return Ok(ActiveKernel::Identity(base_kernel(cursor,input,true,Vec::new())))}
    let full_width=u32::from_le_bytes(command[28..32].try_into().unwrap())as f32;let origin_x=i32::from_le_bytes(command[36..40].try_into().unwrap())as f32;let origin_y=i32::from_le_bytes(command[40..44].try_into().unwrap())as f32;let preview=f32::from_le_bytes(command[44..48].try_into().unwrap());let quality=u32::from_le_bytes(command[48..52].try_into().unwrap());let format=u32::from_le_bytes(command[56..60].try_into().unwrap());let iso=u32::from_le_bytes(command[60..64].try_into().unwrap()).max(1)as f32;let aperture=match format{1=>5.79,2=>12.52,4=>52.15,_=>24.89};let base_px=7.5*(iso/250.0).powf(0.28).clamp(0.65,2.2)*size*(full_width/aperture)/1000.0*preview;let physical=[0.65*base_px/2.35482,1.35*base_px/2.35482,2.80*base_px/2.35482];let fine=0.295+0.300*roughness;let medium=0.380;let coarse=0.325-0.300*roughness;let mut sigmas=physical;let mut weights=[fine,medium,coarse];let scale_count=if fast{sigmas[0]=((fine*physical[0].powi(2)+medium*physical[1].powi(2))/(fine+medium)).sqrt();sigmas[1]=physical[2];weights[0]=fine+medium;weights[1]=coarse;2}else{3};let field_scale=if quality==0{if preview<0.25{4}else if preview<1.0{2}else{1}}else if preview==1.0&&full_width>=4096.0{2}else{1};let field_preview_scale=preview/field_scale as f32;let low_sigmas=[sigmas[0]/field_scale as f32,sigmas[1]/field_scale as f32,sigmas[2]/field_scale as f32];let max_pad=low_sigmas[..scale_count].iter().map(|s|if fast{radius_for_sigma(*s)*3}else{gaussian_radius(*s)}).max().unwrap_or(0);let n=state.width*state.height;let fw=state.width.div_ceil(field_scale)+2*max_pad;let fh=state.height.div_ceil(field_scale)+2*max_pad;let fp=fw.checked_mul(fh).ok_or(ERR_CAPACITY)?;let required=n.checked_mul(3).and_then(|v|v.checked_add(fp.checked_mul(7)?)).ok_or(ERR_CAPACITY)?;if required>state.scratch.len(){return Err(ERR_CAPACITY)}let params=GrainParams{input,output,amount,iso,positive:object_string_eq(command,params_start,params_end,HASH_PROFILE,b"positive"),mask,field_width:fw,field_height:fh,field_pixels:fp,field_scale,max_pad,field_preview_scale,field_origin_x:origin_x-max_pad as f32/field_preview_scale,field_origin_y:origin_y-max_pad as f32/field_preview_scale,exact_stride:if preview==1.0{Some(field_scale as i32)}else{None},exact_origin_x:origin_x as i32-max_pad as i32*field_scale as i32,exact_origin_y:origin_y as i32-max_pad as i32*field_scale as i32,node_prefix:fmix32(fmix32(seed^0x9e37_79b9)^cursor.node_hash),shared_weight:(1.0-0.18*chroma).sqrt(),independent_weight:(0.18*chroma).sqrt()};
    let mut ops=vec![KernelOp::Point(PointOp::new(StepMeta::new(0),PointKind::GrainInit(params),n))];
    for scale in 0..scale_count{ops.push(KernelOp::Point(PointOp::new(StepMeta{phase:1,channel:0,lobe:scale as u32,pass:0},PointKind::GrainGenerate{params,scale},fp)));for channel in 0..4{if low_sigmas[scale]>=0.15{let raw=Plane::Scratch(3*n+channel*fp);let ws=BlurWorkspace{work_out:Plane::Scratch(3*n+4*fp),temp_a:Plane::Scratch(3*n+5*fp),temp_b:Plane::Scratch(3*n+6*fp),low_src:Plane::Scratch(3*n+4*fp),low_dst:Plane::Scratch(3*n+4*fp),low_temp_a:Plane::Scratch(3*n+5*fp),low_temp_b:Plane::Scratch(3*n+6*fp)};ops.push(KernelOp::Blur(BlurOp::new(StepMeta{phase:2,channel:channel as u32,lobe:scale as u32,pass:0},raw,BlurDestination::Replace(raw,1.0),ws,fw,fh,low_sigmas[scale],1,if fast{BlurAlgorithm::Box3}else{BlurAlgorithm::Gaussian})));}}
        let normalization=if fast{resident_box_variance_scale(low_sigmas[scale])}else{resident_gaussian_variance_scale(low_sigmas[scale],&mut state.kernel).ok_or(ERR_CAPACITY)?};let shared=weights[scale].sqrt()*params.shared_weight*normalization;let independent=weights[scale].sqrt()*params.independent_weight*normalization;ops.push(KernelOp::Point(PointOp::new(StepMeta{phase:3,channel:0,lobe:scale as u32,pass:0},PointKind::GrainAccumulate{params,shared,independent},n)));}
    ops.push(KernelOp::Point(PointOp::new(StepMeta::new(4),PointKind::GrainComposite(params),n)));Ok(ActiveKernel::Grain(base_kernel(cursor,output,false,ops)))
}
