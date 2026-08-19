//! Film Halation WebAssembly numeric kernel.
//! Low-level ABI only: JavaScript owns scheduling, PSF lobes and fallback policy.

use std::mem;
use std::slice;

#[no_mangle]
pub extern "C" fn film_version() -> u32 {
    0x01_05_00
}

#[no_mangle]
pub extern "C" fn film_alloc_f32(length: u32) -> *mut f32 {
    let mut buffer = vec![0.0_f32; length as usize];
    let pointer = buffer.as_mut_ptr();
    mem::forget(buffer);
    pointer
}

/// # Safety
/// `pointer` must come from `film_alloc_f32` with the exact same `length`.
#[no_mangle]
pub unsafe extern "C" fn film_free_f32(pointer: *mut f32, length: u32) {
    if pointer.is_null() || length == 0 {
        return;
    }
    drop(Vec::from_raw_parts(
        pointer,
        length as usize,
        length as usize,
    ));
}

fn radius_for_sigma(sigma: f32) -> usize {
    if sigma <= 0.5 {
        return 0;
    }
    (((sigma * sigma + 0.25).sqrt() - 0.5).round() as isize).max(1) as usize
}

fn box_once(
    src: &[f32],
    temp: &mut [f32],
    dst: &mut [f32],
    width: usize,
    height: usize,
    radius: usize,
) {
    if radius == 0 {
        dst.copy_from_slice(src);
        return;
    }
    let denominator = (radius * 2 + 1) as f32;
    for y in 0..height {
        let row = y * width;
        let mut acc = radius as f32 * src[row];
        for k in 0..=radius.min(width - 1) {
            acc += src[row + k];
        }
        for x in 0..width {
            temp[row + x] = acc / denominator;
            let outgoing = x as isize - radius as isize;
            let incoming = x + radius + 1;
            let out_x = outgoing.clamp(0, width as isize - 1) as usize;
            let in_x = incoming.min(width - 1);
            acc -= src[row + out_x];
            acc += src[row + in_x];
        }
    }
    // Keep the vertical pass row-major. The per-column recurrence is
    // unchanged, but contiguous reads/writes avoid a cache miss per pixel on
    // wide Photoshop documents.
    let mut sums = vec![0.0_f32; width];
    let first_rows = radius.min(height - 1);
    for x in 0..width {
        sums[x] = radius as f32 * temp[x];
    }
    for k in 0..=first_rows {
        let row = k * width;
        for x in 0..width {
            sums[x] += temp[row + x];
        }
    }
    for y in 0..height {
        let row = y * width;
        for x in 0..width {
            dst[row + x] = sums[x] / denominator;
        }
        let outgoing = y as isize - radius as isize;
        let incoming = y + radius + 1;
        let out_row = outgoing.clamp(0, height as isize - 1) as usize * width;
        let in_row = incoming.min(height - 1) * width;
        for x in 0..width {
            sums[x] -= temp[out_row + x];
            sums[x] += temp[in_row + x];
        }
    }
}

/// Run the same three-box Gaussian approximation as the JavaScript fallback.
/// The allocation contains four contiguous planes: source, destination, temp A, temp B.
/// Returns 0 on success and a negative code for invalid arguments.
///
/// # Safety
/// `pointer` must address at least `4 * pixels` f32 values allocated by this module.
#[no_mangle]
pub unsafe extern "C" fn film_box_blur3(
    pointer: *mut f32,
    pixels: u32,
    width: u32,
    height: u32,
    sigma: f32,
) -> i32 {
    if pointer.is_null() || width == 0 || height == 0 || width.checked_mul(height) != Some(pixels) {
        return -1;
    }
    let n = pixels as usize;
    let all = slice::from_raw_parts_mut(pointer, n * 4);
    let (source, rest) = all.split_at_mut(n);
    let (destination, rest) = rest.split_at_mut(n);
    let (temp_a, temp_b) = rest.split_at_mut(n);
    let radius = radius_for_sigma(sigma);
    box_once(
        source,
        temp_a,
        destination,
        width as usize,
        height as usize,
        radius,
    );
    box_once(
        destination,
        temp_a,
        temp_b,
        width as usize,
        height as usize,
        radius,
    );
    box_once(
        temp_b,
        temp_a,
        destination,
        width as usize,
        height as usize,
        radius,
    );
    0
}

fn smoothstep(edge0: f32, edge1: f32, value: f32) -> f32 {
    if edge0 == edge1 {
        return if value >= edge1 { 1.0 } else { 0.0 };
    }
    let t = ((value - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn lobe_scale(sigma: f32) -> usize {
    let mut scale = 1;
    for candidate in [2, 4, 8] {
        if sigma / candidate as f32 >= 3.0 {
            scale = candidate;
        }
    }
    scale
}

fn downsample(
    source: &[f32],
    width: usize,
    height: usize,
    scale: usize,
) -> (Vec<f32>, usize, usize) {
    let low_width = width.div_ceil(scale).max(1);
    let low_height = height.div_ceil(scale).max(1);
    let mut output = vec![0.0_f32; low_width * low_height];
    for y in 0..low_height {
        let y0 = y * scale;
        let y1 = ((y + 1) * scale).min(height);
        for x in 0..low_width {
            let x0 = x * scale;
            let x1 = ((x + 1) * scale).min(width);
            let mut sum = 0.0;
            let mut count = 0;
            for yy in y0..y1 {
                for xx in x0..x1 {
                    sum += source[yy * width + xx];
                    count += 1;
                }
            }
            output[y * low_width + x] = if count > 0 { sum / count as f32 } else { 0.0 };
        }
    }
    (output, low_width, low_height)
}

fn upsample(
    source: &[f32],
    sw: usize,
    sh: usize,
    width: usize,
    height: usize,
    scale: usize,
    output: &mut [f32],
) {
    let inverse = 1.0 / scale as f32;
    for y in 0..height {
        let fy = (y as f32 + 0.5) * inverse - 0.5;
        let y0 = if fy < 0.0 {
            0
        } else if fy >= sh as f32 - 1.0 {
            sh - 1
        } else {
            fy.floor() as usize
        };
        let y1 = (y0 + 1).min(sh - 1);
        let ty = fy - y0 as f32;
        for x in 0..width {
            let fx = (x as f32 + 0.5) * inverse - 0.5;
            let x0 = if fx < 0.0 {
                0
            } else if fx >= sw as f32 - 1.0 {
                sw - 1
            } else {
                fx.floor() as usize
            };
            let x1 = (x0 + 1).min(sw - 1);
            let tx = fx - x0 as f32;
            let top = source[y0 * sw + x0] + (source[y0 * sw + x1] - source[y0 * sw + x0]) * tx;
            let bottom = source[y1 * sw + x0] + (source[y1 * sw + x1] - source[y1 * sw + x0]) * tx;
            output[y * width + x] = top + (bottom - top) * ty;
        }
    }
}

fn screen_gain(base: f32) -> f32 {
    if base <= 0.0 {
        1.0
    } else if base < 1.0 {
        1.0 - base
    } else {
        1.0 / base.max(1.0)
    }
}

fn box_three_to(
    source: &mut [f32],
    result: &mut [f32],
    temp: &mut [f32],
    width: usize,
    height: usize,
    sigma: f32,
) {
    let radius = radius_for_sigma(sigma);
    box_once(source, temp, result, width, height, radius);
    box_once(result, temp, source, width, height, radius);
    box_once(source, temp, result, width, height, radius);
}

fn box_three_readonly(
    source: &[f32],
    result: &mut [f32],
    temp_a: &mut [f32],
    temp_b: &mut [f32],
    width: usize,
    height: usize,
    sigma: f32,
) {
    let radius = radius_for_sigma(sigma);
    box_once(source, temp_a, result, width, height, radius);
    box_once(result, temp_a, temp_b, width, height, radius);
    box_once(temp_b, temp_a, result, width, height, radius);
}

fn blur_scaled_low(
    source: &[f32],
    result: &mut [f32],
    width: usize,
    height: usize,
    sigma: f32,
    scale: usize,
) {
    debug_assert!(scale > 1);
    let (mut low_source, low_width, low_height) = downsample(source, width, height, scale);
    let mut low_result = vec![0.0_f32; low_width * low_height];
    let mut low_temp = vec![0.0_f32; low_width * low_height];
    box_three_to(
        &mut low_source,
        &mut low_result,
        &mut low_temp,
        low_width,
        low_height,
        sigma / scale as f32,
    );
    upsample(
        &low_result,
        low_width,
        low_height,
        width,
        height,
        scale,
        result,
    );
}

#[allow(clippy::too_many_arguments)]
fn fill_source_plane(
    destination: &mut [f32],
    rgb: &[f32],
    alpha: &[f32],
    channel: usize,
    threshold: f32,
    source_softness: f32,
    spill_mix: f32,
) {
    let inv_threshold = if threshold > 0.0 {
        1.0 / threshold
    } else {
        1.0
    };
    let t0 = threshold - source_softness * 0.5;
    let t1 = threshold + source_softness * 0.5;
    for (i, value) in destination.iter_mut().enumerate() {
        let p = i * 3;
        let r = rgb[p];
        let g = rgb[p + 1];
        let b = rgb[p + 2];
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let maximum = r.max(g).max(b);
        let s_threshold = smoothstep(t0, t1, y);
        let s_spill = smoothstep(t0, t1, maximum);
        let source_mask =
            (s_threshold * (1.0 - spill_mix) + s_spill * spill_mix) * alpha[i].clamp(0.0, 1.0);
        let radiance = y * (1.0 - spill_mix) + maximum * spill_mix;
        let exposure = (radiance * inv_threshold).max(0.0);
        let green_shoulder = 0.35 + 0.65 * smoothstep(0.75, 2.5, exposure);
        let pr = r.max(0.0);
        let pg = g.max(0.0);
        let pb = b.max(0.0);
        *value = match channel {
            0 => source_mask * ((0.82 * pr + 0.16 * pg + 0.02 * pb) * inv_threshold).max(0.0),
            1 => {
                source_mask
                    * ((0.08 * pr + 0.74 * pg + 0.03 * pb) * inv_threshold).max(0.0)
                    * green_shoulder
            }
            2 => source_mask * ((0.01 * pr + 0.03 * pg + 0.06 * pb) * inv_threshold).max(0.0),
            _ => {
                let source_r =
                    source_mask * ((0.82 * pr + 0.16 * pg + 0.02 * pb) * inv_threshold).max(0.0);
                let source_g = source_mask
                    * ((0.08 * pr + 0.74 * pg + 0.03 * pb) * inv_threshold).max(0.0)
                    * green_shoulder;
                source_r * 0.88 + source_g * 0.12
            }
        };
    }
}

fn fill_source_fields(
    destination: &mut [f32],
    rgb: &[f32],
    alpha: &[f32],
    threshold: f32,
    source_softness: f32,
    spill_mix: f32,
) {
    let n = alpha.len();
    let inv_threshold = if threshold > 0.0 {
        1.0 / threshold
    } else {
        1.0
    };
    let t0 = threshold - source_softness * 0.5;
    let t1 = threshold + source_softness * 0.5;
    for i in 0..n {
        let p = i * 3;
        let r = rgb[p];
        let g = rgb[p + 1];
        let b = rgb[p + 2];
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let maximum = r.max(g).max(b);
        let s_threshold = smoothstep(t0, t1, y);
        let s_spill = smoothstep(t0, t1, maximum);
        let source_mask =
            (s_threshold * (1.0 - spill_mix) + s_spill * spill_mix) * alpha[i].clamp(0.0, 1.0);
        let radiance = y * (1.0 - spill_mix) + maximum * spill_mix;
        let exposure = (radiance * inv_threshold).max(0.0);
        let green_shoulder = 0.35 + 0.65 * smoothstep(0.75, 2.5, exposure);
        let pr = r.max(0.0);
        let pg = g.max(0.0);
        let pb = b.max(0.0);
        destination[i] =
            source_mask * ((0.82 * pr + 0.16 * pg + 0.02 * pb) * inv_threshold).max(0.0);
        destination[n + i] = source_mask
            * ((0.08 * pr + 0.74 * pg + 0.03 * pb) * inv_threshold).max(0.0)
            * green_shoulder;
        destination[n * 2 + i] =
            source_mask * ((0.01 * pr + 0.03 * pg + 0.06 * pb) * inv_threshold).max(0.0);
    }
}

/// Complete Fast pipeline. Linear-memory layout: RGB(3N), alpha(N), output RGB(3N).
/// All threshold values are already converted to linear units by JavaScript.
#[no_mangle]
pub unsafe extern "C" fn film_process_halation_fast(
    pointer: *mut f32,
    pixels: u32,
    width: u32,
    height: u32,
    strength: f32,
    sigma: f32,
    threshold: f32,
    source_softness: f32,
    background_threshold: f32,
    background_softness: f32,
    red_r: f32,
    red_g: f32,
    red_b: f32,
    sigma_r: f32,
    sigma_g: f32,
    sigma_b: f32,
    smoothness: f32,
    global_diffusion: f32,
    center_attenuation: f32,
    blend_mode: u32,
    spill_mix: f32,
) -> i32 {
    if pointer.is_null() || width == 0 || height == 0 || width.checked_mul(height) != Some(pixels) {
        return -1;
    }
    let n = pixels as usize;
    let all = slice::from_raw_parts_mut(pointer, n * 7);
    let (rgb, rest) = all.split_at_mut(n * 3);
    let (alpha, output) = rest.split_at_mut(n);
    if strength == 0.0 {
        output.copy_from_slice(rgb);
        return 0;
    }
    let width = width as usize;
    let height = height as usize;
    let smooth = smoothness.clamp(0.0, 1.0);
    let core_ratio = 0.25 + 0.15 * smooth;
    let tail_ratio = 1.2 + 0.45 * smooth;
    let core_weight = 0.25 - 0.15 * smooth;
    let mut result = vec![0.0_f32; n];
    let mut temp_a = vec![0.0_f32; n];
    let mut temp_b = vec![0.0_f32; n];
    let ratios = [sigma_r, sigma_g, sigma_b];
    let gains = [red_r, red_g, red_b];
    fill_source_fields(output, rgb, alpha, threshold, source_softness, spill_mix);

    // Output starts as three planar spectral source fields. Each field is
    // replaced by its local halo after both PSF lobes have been evaluated.
    for channel in 0..3 {
        let channel_sigma = sigma * ratios[channel];
        let core_sigma = channel_sigma * core_ratio;
        let tail_sigma = channel_sigma * tail_ratio;
        let source = &mut output[channel * n..(channel + 1) * n];
        box_three_readonly(
            source,
            &mut result,
            &mut temp_a,
            &mut temp_b,
            width,
            height,
            core_sigma,
        );
        let tail_scale = lobe_scale(tail_sigma);
        if tail_scale == 1 {
            let mut tail_temp = vec![0.0_f32; n];
            box_three_readonly(
                source,
                &mut temp_a,
                &mut temp_b,
                &mut tail_temp,
                width,
                height,
                tail_sigma,
            );
        } else {
            blur_scaled_low(source, &mut temp_a, width, height, tail_sigma, tail_scale);
        }
        let g0 = background_threshold - background_softness;
        for i in 0..n {
            let p = i * 3;
            let y = 0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2];
            let local_gate = 1.0 - smoothstep(g0, background_threshold, y.clamp(0.0, 1.0));
            let blurred = result[i] * core_weight + temp_a[i] * (1.0 - core_weight);
            source[i] =
                (blurred * gains[channel] - center_attenuation * source[i]).max(0.0) * local_gate;
        }
    }

    if global_diffusion > 0.0 {
        fill_source_plane(
            &mut result,
            rgb,
            alpha,
            3,
            threshold,
            source_softness,
            spill_mix,
        );
        let broad_sigma = 12.0_f32.max(sigma * 4.0);
        let global_scale = lobe_scale(broad_sigma);
        if global_scale == 1 {
            box_three_readonly(
                &result,
                alpha,
                &mut temp_a,
                &mut temp_b,
                width,
                height,
                broad_sigma,
            );
        } else {
            blur_scaled_low(&result, alpha, width, height, broad_sigma, global_scale);
        }
    } else {
        alpha.fill(0.0);
    }
    drop(result);
    drop(temp_a);
    drop(temp_b);

    let mut interleaved = vec![0.0_f32; n * 3];
    let amount = strength * 0.02;
    for i in 0..n {
        let p = i * 3;
        let luminance = (0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2]).max(0.0);
        let midtone = smoothstep(0.03, 0.3, luminance) * (1.0 - smoothstep(0.75, 1.8, luminance));
        let global = alpha[i] * global_diffusion * midtone;
        let halo_r = output[i] + global;
        let halo_g = output[n + i] + global * 0.12;
        let halo_b = output[n * 2 + i] + global * 0.025;
        if blend_mode == 1 {
            interleaved[p] = rgb[p] + screen_gain(rgb[p]) * halo_r * amount;
            interleaved[p + 1] = rgb[p + 1] + screen_gain(rgb[p + 1]) * halo_g * amount;
            interleaved[p + 2] = rgb[p + 2] + screen_gain(rgb[p + 2]) * halo_b * amount;
        } else {
            interleaved[p] = rgb[p] + halo_r * amount;
            interleaved[p + 1] = rgb[p + 1] + halo_g * amount;
            interleaved[p + 2] = rgb[p + 2] + halo_b * amount;
        }
    }
    output.copy_from_slice(&interleaved);
    0
}
