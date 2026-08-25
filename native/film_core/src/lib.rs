//! Film Halation WebAssembly numeric kernel.
//! Low-level ABI only: JavaScript owns scheduling, PSF lobes and fallback policy.

use std::mem;
use std::slice;

#[no_mangle]
pub extern "C" fn film_version() -> u32 {
    0x01_05_02
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

/// O(N) separable square maximum filter used by Strong Source Expansion.
/// The allocation contains three contiguous planes: source, destination and temp.
///
/// # Safety
/// `pointer` must address at least `3 * pixels` f32 values allocated by this module.
#[no_mangle]
pub unsafe extern "C" fn film_max_filter_square(
    pointer: *mut f32,
    pixels: u32,
    width: u32,
    height: u32,
    radius: u32,
) -> i32 {
    if pointer.is_null() || width == 0 || height == 0 || width.checked_mul(height) != Some(pixels) {
        return -1;
    }
    let n = pixels as usize;
    let w = width as usize;
    let h = height as usize;
    let r = radius as usize;
    let all = slice::from_raw_parts_mut(pointer, n * 3);
    let (source, rest) = all.split_at_mut(n);
    let (destination, temp) = rest.split_at_mut(n);
    if r == 0 {
        destination.copy_from_slice(source);
        return 0;
    }

    let mut deque = vec![0_usize; w.max(h)];
    for y in 0..h {
        let row = y * w;
        let mut head = 0_usize;
        let mut tail = 0_usize;
        let mut next = 0_usize;
        for x in 0..w {
            let right = (x + r).min(w - 1);
            while next <= right {
                let value = source[row + next];
                while tail > head && source[row + deque[tail - 1]] <= value {
                    tail -= 1;
                }
                deque[tail] = next;
                tail += 1;
                next += 1;
            }
            let left = x.saturating_sub(r);
            while tail > head && deque[head] < left {
                head += 1;
            }
            temp[row + x] = source[row + deque[head]];
        }
    }

    // Process vertical columns in cache-sized blocks while advancing rows. The
    // incoming temp samples and destination writes are then mostly contiguous;
    // a column-at-a-time deque causes one cache miss per wide-document pixel.
    const COLUMN_BLOCK: usize = 64;
    let mut queues = vec![0_usize; COLUMN_BLOCK * h];
    let mut heads = vec![0_usize; COLUMN_BLOCK];
    let mut tails = vec![0_usize; COLUMN_BLOCK];
    let mut nexts = vec![0_usize; COLUMN_BLOCK];
    for x0 in (0..w).step_by(COLUMN_BLOCK) {
        let block_width = (w - x0).min(COLUMN_BLOCK);
        heads[..block_width].fill(0);
        tails[..block_width].fill(0);
        nexts[..block_width].fill(0);
        for y in 0..h {
            let bottom = (y + r).min(h - 1);
            let top = y.saturating_sub(r);
            let output_row = y * w;
            for local_x in 0..block_width {
                let x = x0 + local_x;
                let base = local_x * h;
                let mut head = heads[local_x];
                let mut tail = tails[local_x];
                let mut next = nexts[local_x];
                while next <= bottom {
                    let value = temp[next * w + x];
                    while tail > head && temp[queues[base + tail - 1] * w + x] <= value {
                        tail -= 1;
                    }
                    queues[base + tail] = next;
                    tail += 1;
                    next += 1;
                }
                while tail > head && queues[base + head] < top {
                    head += 1;
                }
                destination[output_row + x] = temp[queues[base + head] * w + x];
                heads[local_x] = head;
                tails[local_x] = tail;
                nexts[local_x] = next;
            }
        }
    }
    0
}
