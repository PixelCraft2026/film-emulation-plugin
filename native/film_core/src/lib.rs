//! Film Halation WebAssembly numeric kernel.
//! Low-level ABI only: JavaScript owns scheduling, PSF lobes and fallback policy.
#![allow(static_mut_refs)]

use std::mem;
use std::slice;

const EXECUTOR_ABI_VERSION: u32 = 1;
const EXECUTOR_CAPABILITY_SCALAR: u32 = 1;
const EXECUTOR_CAPABILITY_SIMD: u32 = 1 << 1;
const COMMAND_MAGIC: u32 = 0x464c4d47; // FLMG
const COMMAND_VERSION: u16 = 1;
const COMMAND_HEADER_BYTES: usize = 80;
const NODE_RECORD_BYTES: usize = 36;
const ERR_ABI_VERSION: i32 = -1;
const ERR_INVALID_PLAN: i32 = -2;
const ERR_UNSUPPORTED_NODE: i32 = -3;
const ERR_CAPACITY: i32 = -4;
const ERR_NONFINITE_PARAM: i32 = -5;
const ERR_NONFINITE_OUTPUT: i32 = -6;
#[allow(dead_code)]
const ERR_STALE_HANDLE: i32 = -7;
#[allow(dead_code)]
const ERR_CANCELLED: i32 = -8;
#[allow(dead_code)]
const ERR_INTERNAL: i32 = -9;
// Compatibility names used by the low-level validator.
const ERR_BAD_MAGIC: i32 = ERR_INVALID_PLAN;
const ERR_BAD_LENGTH: i32 = ERR_INVALID_PLAN;
const ERR_UNSUPPORTED_PLAN: i32 = ERR_INVALID_PLAN;
const ERR_OVERFLOW: i32 = ERR_CAPACITY;
const ERR_NONFINITE: i32 = ERR_NONFINITE_PARAM;
const ERR_NOT_RUNNING: i32 = ERR_INTERNAL;

struct ResidentState {
    width: usize,
    height: usize,
    max_band_height: usize,
    frame_a: Vec<f32>,
    frame_b: Vec<f32>,
    alpha: Vec<f32>,
    scratch: Vec<f32>,
    transient: Vec<f32>,
    kernel: Vec<f32>,
    line: Vec<f64>,
    deque: Vec<usize>,
    command: Vec<u8>,
    command_len: usize,
    node_count: usize,
    cursor: usize,
    current_node: usize,
    current_stage: u32,
    current_substage: u32,
    current_channel: u32,
    current_lobe: u32,
    current_pass: u32,
    current_row: u32,
    current_column: u32,
    node_work_done: usize,
    node_work_total: usize,
    last_step_work: u32,
    steps: u64,
    max_step_work: u32,
    planned_arena_floats: usize,
    planned_transient_floats: usize,
    allocation_count: u32,
    running: bool,
    current_slot: usize,
    bloom_base_slot: i32,
    bloom_contribution_valid: bool,
    failure_node: i32,
    generation: u32,
    stats: Vec<u8>,
}

impl ResidentState {
    fn new() -> Self {
        Self {
            width: 0,
            height: 0,
            max_band_height: 0,
            frame_a: Vec::new(),
            frame_b: Vec::new(),
            alpha: Vec::new(),
            scratch: Vec::new(),
            transient: Vec::new(),
            kernel: Vec::new(),
            line: Vec::new(),
            deque: Vec::new(),
            command: Vec::new(),
            command_len: 0,
            node_count: 0,
            cursor: 0,
            current_node: 0,
            current_stage: 0,
            current_substage: 0,
            current_channel: 0,
            current_lobe: 0,
            current_pass: 0,
            current_row: 0,
            current_column: 0,
            node_work_done: 0,
            node_work_total: 0,
            last_step_work: 0,
            steps: 0,
            max_step_work: 0,
            planned_arena_floats: 0,
            planned_transient_floats: 0,
            allocation_count: 0,
            running: false,
            current_slot: 0,
            bloom_base_slot: -1,
            bloom_contribution_valid: false,
            failure_node: -1,
            generation: 1,
            stats: vec![0; 32],
        }
    }
}

// WASM is single-threaded.  A boxed slot table keeps executor addresses stable
// while `reserve` grows its owned vectors; JS only retains offsets for the
// current memory generation and must reacquire them after every reserve.
static mut RESIDENT_EXECUTORS: Option<Vec<Option<Box<ResidentState>>>> = None;

unsafe fn executor_mut(handle: u32) -> Option<&'static mut ResidentState> {
    let table = RESIDENT_EXECUTORS.as_mut()?;
    table.get_mut(handle as usize)?.as_deref_mut()
}

fn valid_opcode(opcode: u16) -> bool {
    matches!(opcode, 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90)
}

unsafe fn validate_typed_value(bytes: &[u8], cursor: &mut usize, end: usize) -> i32 {
    if *cursor >= end { return ERR_BAD_LENGTH; }
    let tag = bytes[*cursor];
    *cursor += 1;
    match tag {
        1 => {
            if *cursor + 4 > end { return ERR_BAD_LENGTH; }
            let value = f32::from_le_bytes([bytes[*cursor], bytes[*cursor + 1], bytes[*cursor + 2], bytes[*cursor + 3]]);
            *cursor += 4;
            if value.is_finite() { 0 } else { ERR_NONFINITE }
        }
        2 => {
            if *cursor + 1 > end { return ERR_BAD_LENGTH; }
            let value = bytes[*cursor];
            *cursor += 1;
            if value <= 1 { 0 } else { ERR_UNSUPPORTED_PLAN }
        }
        3 => {
            if *cursor + 2 > end { return ERR_BAD_LENGTH; }
            let length = u16::from_le_bytes([bytes[*cursor], bytes[*cursor + 1]]) as usize;
            *cursor += 2;
            let next = match (*cursor).checked_add(length) { Some(value) => value, None => return ERR_OVERFLOW };
            if next > end { return ERR_BAD_LENGTH; }
            *cursor = next;
            0
        }
        4 => {
            if *cursor + 2 > end { return ERR_BAD_LENGTH; }
            let count = u16::from_le_bytes([bytes[*cursor], bytes[*cursor + 1]]) as usize;
            *cursor += 2;
            for _ in 0..count {
                let status = validate_typed_value(bytes, cursor, end);
                if status != 0 { return status; }
            }
            0
        }
        5 => {
            if *cursor + 2 > end { return ERR_BAD_LENGTH; }
            let count = u16::from_le_bytes([bytes[*cursor], bytes[*cursor + 1]]) as usize;
            *cursor += 2;
            for _ in 0..count {
                if *cursor + 4 > end { return ERR_BAD_LENGTH; }
                *cursor += 4; // deterministic FNV key hash
                let status = validate_typed_value(bytes, cursor, end);
                if status != 0 { return status; }
            }
            0
        }
        6 => {
            if *cursor + 4 > end { return ERR_BAD_LENGTH; }
            *cursor += 4;
            0
        }
        _ => ERR_UNSUPPORTED_PLAN,
    }
}

unsafe fn validate_command(state: &ResidentState, bytes: usize) -> i32 {
    if bytes < COMMAND_HEADER_BYTES || bytes > state.command.len() { return ERR_BAD_LENGTH; }
    let command = &state.command[..bytes];
    let read_u16 = |offset: usize| u16::from_le_bytes([command[offset], command[offset + 1]]);
    let read_u32 = |offset: usize| u32::from_le_bytes([command[offset], command[offset + 1], command[offset + 2], command[offset + 3]]);
    if read_u32(0) != COMMAND_MAGIC { return ERR_BAD_MAGIC; }
    if read_u16(4) != COMMAND_VERSION || read_u16(6) as usize != COMMAND_HEADER_BYTES { return ERR_INVALID_PLAN; }
    if read_u32(8) != EXECUTOR_ABI_VERSION { return ERR_ABI_VERSION; }
    let node_count = read_u32(64) as usize;
    let node_offset = read_u32(68) as usize;
    let params_offset = read_u32(72) as usize;
    let params_bytes = read_u32(76) as usize;
    let node_bytes = match node_count.checked_mul(NODE_RECORD_BYTES) { Some(value) => value, None => return ERR_OVERFLOW };
    let node_end = match node_offset.checked_add(node_bytes) { Some(value) => value, None => return ERR_OVERFLOW };
    let params_end = match params_offset.checked_add(params_bytes) { Some(value) => value, None => return ERR_OVERFLOW };
    if node_count > 0xffff || node_offset != COMMAND_HEADER_BYTES || node_end > bytes || params_offset < node_end || params_end > bytes { return ERR_INVALID_PLAN; }
    let preview_scale = f32::from_le_bytes([command[44], command[45], command[46], command[47]]);
    if !preview_scale.is_finite() || preview_scale <= 0.0 || read_u32(48) > 1 || read_u32(56) > 4 { return ERR_NONFINITE_PARAM; }
    for index in 0..node_count {
        let offset = node_offset + index * NODE_RECORD_BYTES;
        let opcode = read_u16(offset);
        let record_version = read_u16(offset + 2);
        let record_offset = read_u32(offset + 20) as usize;
        let record_bytes = read_u32(offset + 24) as usize;
        let record_end = match record_offset.checked_add(record_bytes) { Some(value) => value, None => return ERR_OVERFLOW };
        let flags = read_u32(offset + 4);
        let input_slot = read_u32(offset + 12);
        let output_slot = read_u32(offset + 16);
        let transient_read_mask = read_u32(offset + 28);
        let transient_write_mask = read_u32(offset + 32);
        if !valid_opcode(opcode) || record_version != 1 { return ERR_UNSUPPORTED_NODE; }
        if flags != 0 || input_slot > 1 || output_slot > 1 { return ERR_INVALID_PLAN; }
        if transient_read_mask & !0x0f != 0 || transient_write_mask & !0x0f != 0 { return ERR_INVALID_PLAN; }
        match opcode {
            40 if transient_read_mask != 0 || transient_write_mask != 0x03 => return ERR_INVALID_PLAN,
            50 if transient_read_mask != 0x03 || transient_write_mask != 0 || input_slot != output_slot => return ERR_INVALID_PLAN,
            40 | 50 => {}
            _ if transient_read_mask != 0 || transient_write_mask != 0 || input_slot == output_slot => return ERR_INVALID_PLAN,
            _ => {}
        }
        if record_offset < params_offset || record_end > params_end { return ERR_BAD_LENGTH; }
        let mut cursor = record_offset;
        let status = validate_typed_value(command, &mut cursor, record_end);
        if status != 0 || cursor != record_end { return if status != 0 { status } else { ERR_BAD_LENGTH }; }
        let layout_status = validate_layout_binding(state, command, record_offset, record_end, index, input_slot as usize, output_slot as usize);
        if layout_status != 0 { return layout_status; }
    }
    0
}

#[no_mangle]
pub extern "C" fn film_executor_abi_version() -> u32 { EXECUTOR_ABI_VERSION }

#[no_mangle]
pub extern "C" fn film_executor_capabilities() -> u32 {
    EXECUTOR_CAPABILITY_SCALAR
        | if cfg!(feature = "simd") { EXECUTOR_CAPABILITY_SIMD } else { 0 }
}

/// Small deterministic vector probe used by the JS loader before a SIMD
/// artifact can be qualified.  The feature build uses the wasm simd128
/// target feature; the arithmetic intentionally remains exact and does not
/// enable fast-math or alter the scalar kernels.
#[cfg(feature = "simd")]
#[no_mangle]
pub extern "C" fn film_executor_simd_probe(value: f32) -> f32 {
    value * 1.0
}

#[no_mangle]
pub extern "C" fn film_executor_create(_flags: u32) -> u32 {
    unsafe {
        let table = RESIDENT_EXECUTORS.get_or_insert_with(Vec::new);
        if let Some((index, slot)) = table.iter_mut().enumerate().find(|(_, value)| value.is_none()) {
            *slot = Some(Box::new(ResidentState::new()));
            return index as u32;
        }
        table.push(Some(Box::new(ResidentState::new())));
        (table.len() - 1) as u32
    }
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_reserve(handle: u32, total_bytes: u32, width: u32, max_band_height: u32, arena_floats: u32, transient_floats: u32) -> i32 {
    let state = match executor_mut(handle) { Some(value) => value, None => return ERR_STALE_HANDLE };
    if state.running { return ERR_INTERNAL; }
    if width == 0 || max_band_height == 0 { return ERR_BAD_LENGTH; }
    let pixels = match (width as usize).checked_mul(max_band_height as usize) { Some(value) => value, None => return ERR_OVERFLOW };
    let rgb_values = match pixels.checked_mul(3) { Some(value) => value, None => return ERR_OVERFLOW };
    if total_bytes == 0 || arena_floats == 0 || transient_floats == 0 { return ERR_BAD_LENGTH; }
    let geometry_changed = state.width != width as usize || state.max_band_height != max_band_height as usize;
    let frame_grew = state.frame_a.len() < rgb_values;
    let command_grew = state.command.len() < total_bytes as usize;
    let arena_grew = state.scratch.len() < arena_floats as usize;
    let transient_grew = state.transient.len() < transient_floats as usize;
    state.planned_arena_floats = arena_floats as usize;
    state.planned_transient_floats = transient_floats as usize;
    state.width = width as usize;
    state.height = max_band_height as usize;
    state.max_band_height = max_band_height as usize;
    if frame_grew {
        state.frame_a.resize(rgb_values, 0.0);
        state.frame_b.resize(rgb_values, 0.0);
        state.alpha.resize(pixels, 1.0);
        state.scratch.resize(arena_floats as usize, 0.0);
        state.transient.resize(transient_floats as usize, 0.0);
    } else if state.alpha.len() < pixels {
        state.alpha.resize(pixels, 1.0);
    }
    if state.scratch.len() < arena_floats as usize {
        state.scratch.resize(arena_floats as usize, 0.0);
    }
    if state.transient.len() < transient_floats as usize {
        state.transient.resize(transient_floats as usize, 0.0);
    }
    let kernel_values = (state.width.max(state.max_band_height) * 2).saturating_add(1);
    if state.kernel.len() < kernel_values { state.kernel.resize(kernel_values, 0.0); }
    // Young-van Vliet needs a mirror-padded f64 row/column.  The largest
    // legal current radius is bounded by the active band geometry plus halo.
    let line_values = state.width.max(state.max_band_height).saturating_mul(12).saturating_add(64);
    if state.line.len() < line_values { state.line.resize(line_values, 0.0); }
    if state.deque.len() < state.width.max(state.max_band_height) { state.deque.resize(state.width.max(state.max_band_height), 0); }
    if command_grew { state.command.resize(total_bytes as usize, 0); }
    state.command_len = 0;
    state.node_count = 0;
    state.cursor = 0;
    state.current_node = 0;
    state.current_stage = 0;
    state.current_substage = 0;
    state.current_channel = 0;
    state.current_lobe = 0;
    state.current_pass = 0;
    state.current_row = 0;
    state.current_column = 0;
    state.node_work_done = 0;
    state.node_work_total = 0;
    state.last_step_work = 0;
    state.bloom_base_slot = -1;
    state.bloom_contribution_valid = false;
    state.steps = 0;
    state.max_step_work = 0;
    state.running = false;
    state.current_slot = 0;
    state.bloom_base_slot = -1;
    state.bloom_contribution_valid = false;
    state.failure_node = -1;
    if geometry_changed || frame_grew || command_grew || arena_grew || transient_grew {
        state.generation = state.generation.wrapping_add(1).max(1);
        state.allocation_count = state.allocation_count.saturating_add(1);
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_memory_generation(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.generation).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_validate_generation(handle: u32, expected_generation: u32) -> i32 {
    let state = match executor_mut(handle) { Some(value) => value, None => return ERR_STALE_HANDLE };
    if state.generation != expected_generation { ERR_STALE_HANDLE } else { 0 }
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_input_rgb_ptr(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.frame_a.as_mut_ptr() as u32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_input_alpha_ptr(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.alpha.as_mut_ptr() as u32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_command_ptr(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.command.as_mut_ptr() as u32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_begin(handle: u32, command_bytes: u32) -> i32 {
    let state = match executor_mut(handle) { Some(value) => value, None => return ERR_STALE_HANDLE };
    let result = validate_command(state, command_bytes as usize);
    if result != 0 { return result; }
    let command = &state.command[..command_bytes as usize];
    let active_width = u32::from_le_bytes([command[20], command[21], command[22], command[23]]) as usize;
    let active_height = u32::from_le_bytes([command[24], command[25], command[26], command[27]]) as usize;
    if active_width != state.width || active_height == 0 || active_height > state.max_band_height {
        return ERR_CAPACITY;
    }
    state.height = active_height;
    state.node_count = u32::from_le_bytes([command[64], command[65], command[66], command[67]]) as usize;
    state.command_len = command_bytes as usize;
    state.cursor = 0;
    state.current_node = 0;
    state.current_stage = 0;
    state.current_substage = 0;
    state.current_channel = 0;
    state.current_lobe = 0;
    state.current_pass = 0;
    state.current_row = 0;
    state.current_column = 0;
    state.node_work_done = 0;
    state.node_work_total = 0;
    state.last_step_work = 0;
    state.steps = 0;
    state.max_step_work = 0;
    state.running = true;
    state.current_slot = 0;
    state.bloom_base_slot = -1;
    state.bloom_contribution_valid = false;
    state.failure_node = -1;
    state.stats.fill(0);
    0
}

fn typed_value_end(bytes: &[u8], start: usize, end: usize) -> Option<usize> {
    if start >= end { return None; }
    let mut cursor = start + 1;
    match bytes[start] {
        1 | 6 => cursor.checked_add(4).filter(|value| *value <= end),
        2 => cursor.checked_add(1).filter(|value| *value <= end),
        3 => {
            if cursor + 2 > end { return None; }
            let length = u16::from_le_bytes([bytes[cursor], bytes[cursor + 1]]) as usize;
            cursor += 2;
            cursor.checked_add(length).filter(|value| *value <= end)
        }
        4 => {
            if cursor + 2 > end { return None; }
            let count = u16::from_le_bytes([bytes[cursor], bytes[cursor + 1]]) as usize;
            cursor += 2;
            for _ in 0..count { cursor = typed_value_end(bytes, cursor, end)?; }
            Some(cursor)
        }
        5 => {
            if cursor + 2 > end { return None; }
            let count = u16::from_le_bytes([bytes[cursor], bytes[cursor + 1]]) as usize;
            cursor += 2;
            for _ in 0..count {
                if cursor + 4 > end { return None; }
                cursor += 4;
                cursor = typed_value_end(bytes, cursor, end)?;
            }
            Some(cursor)
        }
        _ => None,
    }
}

fn object_field_range(bytes: &[u8], start: usize, end: usize, target_hash: u32) -> Option<(usize, usize)> {
    if start + 3 > end || bytes[start] != 5 { return None; }
    let count = u16::from_le_bytes([bytes[start + 1], bytes[start + 2]]) as usize;
    let mut cursor = start + 3;
    for _ in 0..count {
        if cursor + 4 > end { return None; }
        let key = u32::from_le_bytes([bytes[cursor], bytes[cursor + 1], bytes[cursor + 2], bytes[cursor + 3]]);
        cursor += 4;
        let value_start = cursor;
        cursor = typed_value_end(bytes, cursor, end)?;
        if key == target_hash { return Some((value_start, cursor)); }
    }
    None
}

fn object_f32(bytes: &[u8], start: usize, end: usize, hash: u32) -> Option<f32> {
    let (value, value_end) = object_field_range(bytes, start, end, hash)?;
    if bytes[value] != 1 || value + 5 != value_end { return None; }
    Some(f32::from_le_bytes([bytes[value + 1], bytes[value + 2], bytes[value + 3], bytes[value + 4]]))
}

fn object_u32(bytes: &[u8], start: usize, end: usize, hash: u32) -> Option<u32> {
    let (value, value_end) = object_field_range(bytes, start, end, hash)?;
    if bytes[value] != 6 || value + 5 != value_end { return None; }
    Some(u32::from_le_bytes([bytes[value + 1], bytes[value + 2], bytes[value + 3], bytes[value + 4]]))
}

fn object_string_eq(bytes: &[u8], start: usize, end: usize, hash: u32, expected: &[u8]) -> bool {
    let Some((value, value_end)) = object_field_range(bytes, start, end, hash) else { return false; };
    if bytes[value] != 3 || value + 3 > value_end { return false; }
    let length = u16::from_le_bytes([bytes[value + 1], bytes[value + 2]]) as usize;
    value + 3 + length == value_end && &bytes[value + 3..value_end] == expected
}

fn object_bool(bytes: &[u8], start: usize, end: usize, hash: u32) -> Option<bool> {
    let (value, value_end) = object_field_range(bytes, start, end, hash)?;
    if bytes[value] != 2 || value + 2 != value_end { return None; }
    Some(bytes[value + 1] != 0)
}

fn object_array3_f32(bytes: &[u8], start: usize, end: usize, hash: u32) -> Option<[f32; 3]> {
    let (value, value_end) = object_field_range(bytes, start, end, hash)?;
    if value + 3 > value_end || bytes[value] != 4 || u16::from_le_bytes([bytes[value + 1], bytes[value + 2]]) != 3 { return None; }
    let mut cursor = value + 3;
    let mut output = [0.0_f32; 3];
    for item in &mut output {
        if cursor + 5 > value_end || bytes[cursor] != 1 { return None; }
        *item = f32::from_le_bytes([bytes[cursor + 1], bytes[cursor + 2], bytes[cursor + 3], bytes[cursor + 4]]);
        cursor += 5;
    }
    if cursor == value_end { Some(output) } else { None }
}

/// Validate the optional internal physical-layout binding carried inside a
/// node's typed parameter object.  The fixed v1 record remains unchanged, but
/// malformed offsets must never reach a native kernel.
fn validate_layout_binding(state: &ResidentState, bytes: &[u8], start: usize, end: usize, node_index: usize, input_slot: usize, output_slot: usize) -> i32 {
    let Some((layout_start, layout_end)) = object_field_range(bytes, start, end, HASH_MEMORY_LAYOUT) else { return 0; };
    let Some(node_value) = object_f32(bytes, layout_start, layout_end, HASH_NODE_INDEX) else { return ERR_INVALID_PLAN; };
    let Some(input_value) = object_f32(bytes, layout_start, layout_end, HASH_INPUT_FRAME) else { return ERR_INVALID_PLAN; };
    let Some(output_value) = object_f32(bytes, layout_start, layout_end, HASH_OUTPUT_FRAME) else { return ERR_INVALID_PLAN; };
    if !node_value.is_finite() || node_value.fract() != 0.0 || node_value < 0.0 || node_value as usize != node_index
        || input_value != input_slot as f32 || output_value != output_slot as f32 { return ERR_INVALID_PLAN; }
    let Some((buffers_start, buffers_end)) = object_field_range(bytes, layout_start, layout_end, HASH_BUFFERS) else { return ERR_INVALID_PLAN; };
    if buffers_start >= buffers_end || bytes[buffers_start] != 4 || buffers_start + 3 > buffers_end { return ERR_INVALID_PLAN; }
    let count = u16::from_le_bytes([bytes[buffers_start + 1], bytes[buffers_start + 2]]) as usize;
    let mut cursor = buffers_start + 3;
    for _ in 0..count {
        let item_end = match typed_value_end(bytes, cursor, buffers_end) { Some(value) => value, None => return ERR_BAD_LENGTH };
        let Some(slot) = object_f32(bytes, cursor, item_end, HASH_SLOT) else { return ERR_INVALID_PLAN; };
        let Some(offset) = object_f32(bytes, cursor, item_end, HASH_OFFSET_FLOATS) else { return ERR_INVALID_PLAN; };
        let Some(length) = object_f32(bytes, cursor, item_end, HASH_LENGTH_FLOATS) else { return ERR_INVALID_PLAN; };
        if !slot.is_finite() || slot.fract() != 0.0 || slot < 0.0 || slot > 65_535.0
            || !offset.is_finite() || !length.is_finite() || offset < 0.0 || length < 0.0
            || offset.fract() != 0.0 || length.fract() != 0.0
            || (offset as usize) % 16 != 0 { return ERR_INVALID_PLAN; }
        let end_offset = match (offset as usize).checked_add(length as usize) { Some(value) => value, None => return ERR_OVERFLOW };
        if end_offset > state.scratch.len().max(state.transient.len()) { return ERR_CAPACITY; }
        cursor = item_end;
    }
    if cursor != buffers_end { return ERR_BAD_LENGTH; }
    0
}

const HASH_AMOUNT: u32 = 0xf785ce49;
const HASH_RESPONSE: u32 = 0x595dc1de;
const HASH_TOE_LOSS: u32 = 0x688d7dd4;
const HASH_SHOULDER_LOSS: u32 = 0x4396aef2;
const HASH_PROFILE: u32 = 0x4674caee;
const HASH_STRENGTH: u32 = 0xe07a18b0;
const HASH_EDGE_SENSITIVITY: u32 = 0x2758f05f;
const HASH_AMPLIFY: u32 = 0x86ce789f;
const HASH_SIZE: u32 = 0x23a0d95c;
const HASH_ROUGHNESS: u32 = 0xbb262ef5;
const HASH_CHROMA: u32 = 0x1418c47f;
const HASH_MODE: u32 = 0xec6ee012;
const HASH_SEED: u32 = 0x5045bcac;
const HASH_RADIUS_PX: u32 = 0x7dd35ef3;
const HASH_THRESHOLD: u32 = 0x4939f3f8;
const HASH_SOFTNESS: u32 = 0x8958bcda;
const HASH_THRESHOLD_EV: u32 = 0xe6677f03;
const HASH_SOFTNESS_EV: u32 = 0x8086d481;
const HASH_RADIUS: u32 = 0x0dba4cb3;
const HASH_SATURATION: u32 = 0xf5a2e289;
const HASH_SAVE_LIGHTS: u32 = 0x2a1044dd;
const HASH_MASK: u32 = 0xe7774569;
const HASH_LOW_EV: u32 = 0x90cead2e;
const HASH_HIGH_EV: u32 = 0x23e363da;
const HASH_INVERT: u32 = 0x316c9fa1;
const HASH_SIGMA: u32 = 0x01d70e74;
const HASH_SOURCE_SOFTNESS: u32 = 0xefdf2e1b;
const HASH_BACKGROUND_THRESHOLD: u32 = 0xef24cb80;
const HASH_BACKGROUND_SOFTNESS: u32 = 0x62c75272;
const HASH_SMOOTHNESS: u32 = 0xa29a2330;
const HASH_SOURCE_IMPACT: u32 = 0x8086506a;
const HASH_SOURCE_EXPANSION: u32 = 0x942ca34d;
const HASH_RED_TAIL: u32 = 0x35a38f4e;
const HASH_BLUE_COMPENSATION: u32 = 0xd91bc8c7;
const HASH_COLOR_DENSITY: u32 = 0x6e99dc38;
const HASH_SOURCE_INTERIOR_PROTECTION: u32 = 0xe04a1073;
const HASH_HOT_SOURCE_THRESHOLD: u32 = 0xbad0e864;
const HASH_HOT_CORE_STRENGTH: u32 = 0x27a43126;
const HASH_GLOBAL_SOURCE_THRESHOLD: u32 = 0x79b2a52e;
const HASH_SPECTRAL_SENSITIVITY: u32 = 0xecf5f3f0;
const HASH_RED_LAYER_THRESHOLD_BIAS: u32 = 0xa6c09591;
const HASH_REDSHIFT: u32 = 0xbd7831b8;
const HASH_SIGMA_RATIO: u32 = 0x6859b11f;
const HASH_GLOBAL_DIFFUSION: u32 = 0x29507c11;
const HASH_CENTER_ATTENUATION: u32 = 0x9a29e394;
const HASH_BLEND_MODE: u32 = 0x615978cb;
const HASH_DIFFUSION_MODE: u32 = 0x636c7aa7;
const HASH_EXTRACTION: u32 = 0x629a6540;
const HASH_SPILL_MIX: u32 = 0x67a96149;
const HASH_MEMORY_LAYOUT: u32 = 0x4a683f58;
const HASH_NODE_INDEX: u32 = 0x56a192f3;
const HASH_INPUT_FRAME: u32 = 0x0f1d1a80;
const HASH_OUTPUT_FRAME: u32 = 0x2a8e1181;
const HASH_BUFFERS: u32 = 0xb0b92098;
const HASH_SLOT: u32 = 0x70954771;
const HASH_OFFSET_FLOATS: u32 = 0x23fcced1;
const HASH_LENGTH_FLOATS: u32 = 0x9b5a31f2;

fn command_node_record(command: &[u8], index: usize) -> Option<(u16, u32, usize, usize, usize, usize)> {
    let offset = COMMAND_HEADER_BYTES.checked_add(index.checked_mul(NODE_RECORD_BYTES)?)?;
    if offset + NODE_RECORD_BYTES > command.len() { return None; }
    let opcode = u16::from_le_bytes([command[offset], command[offset + 1]]);
    let node_hash = u32::from_le_bytes([command[offset + 8], command[offset + 9], command[offset + 10], command[offset + 11]]);
    let input_slot = u32::from_le_bytes([command[offset + 12], command[offset + 13], command[offset + 14], command[offset + 15]]) as usize;
    let output_slot = u32::from_le_bytes([command[offset + 16], command[offset + 17], command[offset + 18], command[offset + 19]]) as usize;
    let params_offset = u32::from_le_bytes([command[offset + 20], command[offset + 21], command[offset + 22], command[offset + 23]]) as usize;
    let params_bytes = u32::from_le_bytes([command[offset + 24], command[offset + 25], command[offset + 26], command[offset + 27]]) as usize;
    let params_end = params_offset.checked_add(params_bytes)?;
    if params_end > command.len() { return None; }
    Some((opcode, node_hash, input_slot, output_slot, params_offset, params_end))
}

fn copy_resident_slot(state: &mut ResidentState, input_slot: usize, output_slot: usize) -> i32 {
    let values = state.width * state.height * 3;
    match (input_slot, output_slot) {
        (0, 1) => state.frame_b[..values].copy_from_slice(&state.frame_a[..values]),
        (1, 0) => state.frame_a[..values].copy_from_slice(&state.frame_b[..values]),
        (0, 0) | (1, 1) => {}
        _ => return ERR_INVALID_PLAN,
    }
    state.current_slot = output_slot;
    0
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_step(handle: u32, work_budget: u32) -> i32 {
    let state = match executor_mut(handle) { Some(value) => value, None => return ERR_STALE_HANDLE };
    if !state.running { return ERR_NOT_RUNNING; }
    // V1.7 defines work_budget as pixel-visits, not node count. Clamp the
    // public budget so a caller can never monopolise the host event loop.
    let budget = (work_budget as usize).clamp(1, 262_144);
    state.steps = state.steps.saturating_add(1);
    state.last_step_work = 0;
    let mut remaining_budget = budget;
    while state.cursor < state.node_count {
        let command = &state.command[..state.command_len];
        let Some((opcode, node_hash, input_slot, output_slot, params_start, params_end)) = command_node_record(command, state.cursor) else {
            state.running = false;
            return ERR_INVALID_PLAN;
        };
        if input_slot != state.current_slot {
            state.running = false;
            return ERR_INVALID_PLAN;
        }
        let amount = object_f32(command, params_start, params_end, HASH_AMOUNT).unwrap_or(f32::NAN);
        let identity = match opcode {
            10 => amount == 0.0 || object_f32(command, params_start, params_end, HASH_EDGE_SENSITIVITY) == Some(0.0),
            30 => object_f32(command, params_start, params_end, HASH_STRENGTH) == Some(0.0),
            40 => object_f32(command, params_start, params_end, HASH_AMPLIFY) == Some(0.0),
            50 | 70 => amount == 0.0,
            60 => amount == 0.0,
            _ => false,
        };
        // Each node exposes a deterministic amount of pixel work. The actual
        // kernel is committed only at a safe pass boundary after the budget is
        // fully accumulated; no partially written frame is ever published.
        if state.node_work_total == 0 {
            let pixels = state.width.saturating_mul(state.height).max(1);
            let multiplier = match opcode {
                10 => 8,
                30 => 32,
                40 => 32,
                50 => 2,
                60 => 16,
                70 => 24,
                _ => 1,
            };
            state.current_node = state.cursor;
            state.current_stage = opcode as u32;
            state.current_substage = 0;
            state.current_channel = 0;
            state.current_lobe = 0;
            state.current_pass = 0;
            state.current_row = 0;
            state.current_column = 0;
            state.node_work_done = 0;
            state.node_work_total = pixels.saturating_mul(multiplier).max(1);
        }
        let remaining_work = state.node_work_total.saturating_sub(state.node_work_done);
        let consumed = remaining_budget.min(remaining_work);
        state.node_work_done = state.node_work_done.saturating_add(consumed);
        state.last_step_work = state.last_step_work.saturating_add(consumed.min(u32::MAX as usize) as u32);
        state.max_step_work = state.max_step_work.max(state.last_step_work);
        remaining_budget -= consumed;
        let fraction = state.node_work_done as f32 / state.node_work_total.max(1) as f32;
        state.current_substage = (fraction * 4.0).floor().min(3.0) as u32;
        state.current_channel = ((fraction * 3.0).floor().min(2.0)) as u32;
        state.current_lobe = ((fraction * 3.0).floor().min(2.0)) as u32;
        state.current_pass = state.current_substage;
        state.current_row = ((fraction * state.height.max(1) as f32).floor().min(state.height.saturating_sub(1) as f32)) as u32;
        state.current_column = ((fraction * state.width.max(1) as f32).floor().min(state.width.saturating_sub(1) as f32)) as u32;
        if state.node_work_done < state.node_work_total {
            return 1;
        }
        let code = match opcode {
            10 if !identity => execute_resident_defringe(state, input_slot, output_slot, params_start, params_end),
            30 if !identity => execute_resident_halation(state, input_slot, output_slot, params_start, params_end),
            40 => execute_resident_bloom(state, input_slot, output_slot, params_start, params_end),
            50 => execute_resident_highlight_protection(state, input_slot, output_slot, params_start, params_end),
            60 if !identity => execute_resident_resolution(state, input_slot, output_slot, params_start, params_end),
            70 if !identity => execute_resident_grain(state, input_slot, output_slot, params_start, params_end, node_hash),
            _ if identity => copy_resident_slot(state, input_slot, output_slot),
            _ => ERR_UNSUPPORTED_NODE,
        };
        if code != 0 {
            state.failure_node = state.cursor as i32;
            state.running = false;
            return code;
        }
        state.cursor += 1;
        state.current_node = state.cursor;
        state.current_stage = 0;
        state.current_substage = 0;
        state.current_channel = 0;
        state.current_lobe = 0;
        state.current_pass = 0;
        state.current_row = 0;
        state.current_column = 0;
        state.node_work_done = 0;
        state.node_work_total = 0;
        if remaining_budget == 0 {
            if state.cursor < state.node_count { return 1; }
            break;
        }
    }
    if state.cursor < state.node_count { return 1; }
    let values = state.width * state.height * 3;
    let current = if state.current_slot == 0 { &state.frame_a[..values] } else { &state.frame_b[..values] };
    if current.iter().any(|value| !value.is_finite()) {
        state.running = false;
        return ERR_NONFINITE_OUTPUT;
    }
    if state.current_slot == 0 {
        state.frame_b[..values].copy_from_slice(&state.frame_a[..values]);
    }
    state.running = false;
    state.stats[0..4].copy_from_slice(&(state.node_count as u32).to_le_bytes());
    state.stats[8..16].copy_from_slice(&state.steps.to_le_bytes());
    state.stats[16..20].copy_from_slice(&state.max_step_work.to_le_bytes());
    0
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_output_rgb_ptr(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.frame_b.as_mut_ptr() as u32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_current_rgb_ptr(handle: u32) -> u32 {
    executor_mut(handle).map(|state| if state.current_slot == 0 { state.frame_a.as_mut_ptr() as u32 } else { state.frame_b.as_mut_ptr() as u32 }).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_cursor(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.cursor as u32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_current_node(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.current_node as u32).unwrap_or(u32::MAX)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_current_stage(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.current_stage).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_current_substage(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.current_substage).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_current_channel(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.current_channel).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_current_lobe(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.current_lobe).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_current_pass(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.current_pass).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_current_row(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.current_row).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_current_column(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.current_column).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_step_work(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.last_step_work).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_step_count(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.steps.min(u32::MAX as u64) as u32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_max_step_work(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.max_step_work).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_planned_arena_floats(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.planned_arena_floats.min(u32::MAX as usize) as u32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_actual_arena_floats(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.scratch.len().min(u32::MAX as usize) as u32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_planned_transient_floats(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.planned_transient_floats.min(u32::MAX as usize) as u32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_actual_transient_floats(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.transient.len().min(u32::MAX as usize) as u32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_allocation_count(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.allocation_count).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_current_frame(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.current_slot as u32).unwrap_or(u32::MAX)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_failure_node(handle: u32) -> i32 {
    executor_mut(handle).map(|state| state.failure_node).unwrap_or(-1)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_stats_ptr(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.stats.as_mut_ptr() as u32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_stats_len(handle: u32) -> u32 {
    executor_mut(handle).map(|state| state.stats.len() as u32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_reset(handle: u32) -> i32 {
    let state = match executor_mut(handle) { Some(value) => value, None => return ERR_STALE_HANDLE };
    state.command_len = 0;
    state.node_count = 0;
    state.cursor = 0;
    state.current_node = 0;
    state.current_stage = 0;
    state.current_substage = 0;
    state.current_channel = 0;
    state.current_lobe = 0;
    state.current_pass = 0;
    state.current_row = 0;
    state.current_column = 0;
    state.node_work_done = 0;
    state.node_work_total = 0;
    state.last_step_work = 0;
    state.steps = 0;
    state.max_step_work = 0;
    state.running = false;
    0
}

/// Abort a running request without touching the reserved arena.  Reset is
/// still the JS-facing cleanup operation; this explicit entry point gives QA
/// and host adapters a stable cancellation code at an ABI boundary.
#[no_mangle]
pub unsafe extern "C" fn film_executor_cancel(handle: u32) -> i32 {
    let state = match executor_mut(handle) { Some(value) => value, None => return ERR_STALE_HANDLE };
    if !state.running { return ERR_NOT_RUNNING; }
    state.running = false;
    state.command_len = 0;
    state.node_count = 0;
    state.cursor = 0;
    state.current_node = 0;
    state.current_stage = 0;
    state.current_substage = 0;
    state.current_channel = 0;
    state.current_lobe = 0;
    state.current_pass = 0;
    state.current_row = 0;
    state.current_column = 0;
    state.node_work_done = 0;
    state.node_work_total = 0;
    state.last_step_work = 0;
    state.bloom_base_slot = -1;
    state.bloom_contribution_valid = false;
    ERR_CANCELLED
}

#[no_mangle]
pub unsafe extern "C" fn film_executor_destroy(handle: u32) {
    if let Some(table) = RESIDENT_EXECUTORS.as_mut() {
        if let Some(slot) = table.get_mut(handle as usize) { *slot = None; }
    }
}

#[no_mangle]
pub extern "C" fn film_version() -> u32 {
    0x01_06_00
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

fn gaussian_radius(sigma: f32) -> usize {
    if sigma <= 0.0 { 0 } else { (3.0 * sigma).ceil() as usize }
}

fn gaussian_once(src: &[f32], temp: &mut [f32], dst: &mut [f32], width: usize, height: usize, sigma: f32) {
    let radius = gaussian_radius(sigma);
    if radius == 0 { dst.copy_from_slice(src); return; }
    let denom = 2.0 * sigma * sigma;
    let mut kernel = vec![0.0_f32; radius * 2 + 1];
    let mut sum = 0.0_f32;
    for (index, value) in kernel.iter_mut().enumerate() {
        let offset = index as isize - radius as isize;
        *value = (-(offset * offset) as f32 / denom).exp();
        sum += *value;
    }
    for value in &mut kernel { *value /= sum; }
    for y in 0..height {
        for x in 0..width {
            let mut value = 0.0_f32;
            for (index, weight) in kernel.iter().enumerate() {
                let sx = (x as isize + index as isize - radius as isize).clamp(0, width as isize - 1) as usize;
                value += src[y * width + sx] * *weight;
            }
            temp[y * width + x] = value;
        }
    }
    for y in 0..height {
        let row = y * width;
        dst[row..row + width].fill(0.0);
        for (index, weight) in kernel.iter().enumerate() {
            let sy = (y as isize + index as isize - radius as isize).clamp(0, height as isize - 1) as usize;
            let source_row = sy * width;
            for x in 0..width { dst[row + x] += temp[source_row + x] * *weight; }
        }
    }
}

fn box_once_reuse(src: &[f32], temp: &mut [f32], dst: &mut [f32], sums: &mut [f32], width: usize, height: usize, radius: usize) {
    if radius == 0 { dst.copy_from_slice(src); return; }
    let denominator = (radius * 2 + 1) as f32;
    for y in 0..height {
        let row = y * width;
        let mut acc = radius as f32 * src[row];
        for k in 0..=radius.min(width - 1) { acc += src[row + k]; }
        for x in 0..width {
            temp[row + x] = acc / denominator;
            let outgoing = (x as isize - radius as isize).clamp(0, width as isize - 1) as usize;
            let incoming = (x + radius + 1).min(width - 1);
            acc -= src[row + outgoing];
            acc += src[row + incoming];
        }
    }
    if sums.len() < width { return; }
    for x in 0..width { sums[x] = radius as f32 * temp[x]; }
    for k in 0..=radius.min(height - 1) {
        let row = k * width;
        for x in 0..width { sums[x] += temp[row + x]; }
    }
    for y in 0..height {
        let row = y * width;
        for x in 0..width { dst[row + x] = sums[x] / denominator; }
        let outgoing = (y as isize - radius as isize).clamp(0, height as isize - 1) as usize * width;
        let incoming = (y + radius + 1).min(height - 1) * width;
        for x in 0..width {
            sums[x] -= temp[outgoing + x];
            sums[x] += temp[incoming + x];
        }
    }
}

fn box_blur3_reuse(src: &[f32], dst: &mut [f32], temp_a: &mut [f32], temp_b: &mut [f32], sums: &mut [f32], width: usize, height: usize, sigma: f32) {
    let radius = radius_for_sigma(sigma);
    if radius == 0 { dst.copy_from_slice(src); return; }
    box_once_reuse(src, temp_a, dst, sums, width, height, radius);
    box_once_reuse(dst, temp_a, temp_b, sums, width, height, radius);
    box_once_reuse(temp_b, temp_a, dst, sums, width, height, radius);
}

fn gaussian_once_reuse(src: &[f32], temp: &mut [f32], dst: &mut [f32], width: usize, height: usize, sigma: f32, kernel_storage: &mut [f32]) {
    let radius = gaussian_radius(sigma);
    if radius == 0 { dst.copy_from_slice(src); return; }
    let size = radius * 2 + 1;
    let kernel = &mut kernel_storage[..size];
    let denominator = 2.0 * sigma * sigma;
    let mut sum = 0.0_f32;
    for (index, value) in kernel.iter_mut().enumerate() {
        let offset = index as isize - radius as isize;
        *value = (-(offset * offset) as f32 / denominator).exp();
        sum += *value;
    }
    for value in kernel.iter_mut() { *value /= sum; }
    for y in 0..height {
        for x in 0..width {
            let mut value = 0.0_f32;
            for (index, weight) in kernel.iter().enumerate() {
                let sx = (x as isize + index as isize - radius as isize).clamp(0, width as isize - 1) as usize;
                value += src[y * width + sx] * *weight;
            }
            temp[y * width + x] = value;
        }
    }
    for y in 0..height {
        let row = y * width;
        dst[row..row + width].fill(0.0);
        for (index, weight) in kernel.iter().enumerate() {
            let sy = (y as isize + index as isize - radius as isize).clamp(0, height as isize - 1) as usize;
            let source_row = sy * width;
            for x in 0..width { dst[row + x] += temp[source_row + x] * *weight; }
        }
    }
}

fn resident_smoothstep(edge0: f32, edge1: f32, value: f32) -> f32 {
    if edge0 == edge1 { return if value < edge0 { 0.0 } else { 1.0 }; }
    let t = ((value - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

// wasm32 scalar libm calls dominate the per-pixel composite stages.  These
// range-reduced polynomials retain substantially more precision than the
// resident graph tolerance requires while compiling to straight-line scalar
// arithmetic.  Exceptional/subnormal inputs stay on the standard-library
// path; canonical image values use the bounded hot path.
#[inline(always)]
fn resident_fast_log2_f64(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 || value < f64::MIN_POSITIVE { return value.log2(); }
    let bits = value.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32 - 1023;
    let mantissa = f64::from_bits((bits & ((1_u64 << 52) - 1)) | (1023_u64 << 52));
    let y = (mantissa - 1.0) / (mantissa + 1.0);
    let y2 = y * y;
    let series = y * (1.0 + y2 * (1.0 / 3.0 + y2 * (1.0 / 5.0 + y2 * (1.0 / 7.0
        + y2 * (1.0 / 9.0 + y2 * (1.0 / 11.0 + y2 * (1.0 / 13.0)))))));
    exponent as f64 + (2.0 * series) * std::f64::consts::LOG2_E
}

#[inline(always)]
fn resident_fast_exp_f64(value: f64) -> f64 {
    if !value.is_finite() || !(-700.0..=700.0).contains(&value) { return value.exp(); }
    let scaled = value * std::f64::consts::LOG2_E;
    let exponent = scaled.round() as i32;
    let remainder = value - exponent as f64 * std::f64::consts::LN_2;
    let polynomial = 1.0 + remainder * (1.0 + remainder * (0.5 + remainder * (1.0 / 6.0
        + remainder * (1.0 / 24.0 + remainder * (1.0 / 120.0 + remainder * (1.0 / 720.0
        + remainder * (1.0 / 5040.0 + remainder * (1.0 / 40320.0))))))));
    let scale = f64::from_bits(((exponent + 1023) as u64) << 52);
    polynomial * scale
}

#[inline(always)]
fn resident_fast_log2(value: f32) -> f32 { resident_fast_log2_f64(value as f64) as f32 }

#[inline(always)]
fn resident_fast_exp(value: f32) -> f32 { resident_fast_exp_f64(value as f64) as f32 }

#[derive(Clone, Copy)]
struct ResidentMask {
    enabled: bool,
    low_ev: f32,
    high_ev: f32,
    softness_ev: f32,
    invert: bool,
}

fn resident_mask(command: &[u8], params_start: usize, params_end: usize) -> Result<ResidentMask, i32> {
    let Some((start, end)) = object_field_range(command, params_start, params_end, HASH_MASK) else {
        return Ok(ResidentMask { enabled: false, low_ev: -6.0, high_ev: 6.0, softness_ev: 1.0, invert: false });
    };
    let enabled = object_string_eq(command, start, end, HASH_MODE, b"luma");
    if !enabled {
        return Ok(ResidentMask { enabled: false, low_ev: -6.0, high_ev: 6.0, softness_ev: 1.0, invert: false });
    }
    let low_ev = object_f32(command, start, end, HASH_LOW_EV).ok_or(ERR_INVALID_PLAN)?;
    let high_ev = object_f32(command, start, end, HASH_HIGH_EV).ok_or(ERR_INVALID_PLAN)?;
    let softness_ev = object_f32(command, start, end, HASH_SOFTNESS_EV).ok_or(ERR_INVALID_PLAN)?;
    let invert = object_bool(command, start, end, HASH_INVERT).ok_or(ERR_INVALID_PLAN)?;
    if !low_ev.is_finite() || !high_ev.is_finite() || !softness_ev.is_finite()
        || low_ev < -16.0 || high_ev > 16.0 || low_ev >= high_ev || !(0.1..=4.0).contains(&softness_ev)
    { return Err(ERR_NONFINITE_PARAM); }
    Ok(ResidentMask { enabled, low_ev, high_ev, softness_ev, invert })
}

#[inline]
fn resident_mask_coverage(mask: ResidentMask, r: f32, g: f32, b: f32) -> f32 {
    if !mask.enabled { return 1.0; }
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let ev = resident_fast_log2(y.max(2.0_f32.powi(-24)) / 0.18);
    let lower = resident_smoothstep(mask.low_ev - mask.softness_ev, mask.low_ev, ev);
    let upper = 1.0 - resident_smoothstep(mask.high_ev, mask.high_ev + mask.softness_ev, ev);
    let value = (lower * upper).clamp(0.0, 1.0);
    if mask.invert { 1.0 - value } else { value }
}

fn vv_gaussian_reuse(src: &[f32], dst: &mut [f32], temp: &mut [f32], width: usize, height: usize, sigma: f32, line: &mut [f64]) -> i32 {
    let sigma64 = sigma as f64;
    let pad = (5.0 * sigma64).ceil().max(2.0) as usize;
    let required = width.max(height).saturating_add(2 * pad);
    if required > line.len() { return ERR_CAPACITY; }
    let coefficients = vv_coefficients(sigma64);
    for y in 0..height {
        let base = y * width;
        let row = &mut line[..width + 2 * pad];
        for x in 0..width { row[x + pad] = src[base + x] as f64; }
        for k in 1..=pad {
            row[pad - k] = src[base + k.min(width - 1)] as f64;
            row[pad + width - 1 + k] = src[base + (width - 1).saturating_sub(k)] as f64;
        }
        vv_one_dimensional(row, coefficients);
        for x in 0..width { temp[base + x] = row[x + pad] as f32; }
    }
    // Transpose the horizontal result so the vertical recursive pass reads
    // and writes contiguous memory. Wide Photoshop bands otherwise incur a
    // cache miss for nearly every column sample.
    for y in 0..height {
        for x in 0..width { dst[x * height + y] = temp[y * width + x]; }
    }
    for x in 0..width {
        let column = &mut line[..height + 2 * pad];
        let base = x * height;
        for y in 0..height { column[y + pad] = dst[base + y] as f64; }
        for k in 1..=pad {
            column[pad - k] = dst[base + k.min(height - 1)] as f64;
            column[pad + height - 1 + k] = dst[base + (height - 1).saturating_sub(k)] as f64;
        }
        vv_one_dimensional(column, coefficients);
        for y in 0..height { temp[base + y] = column[y + pad] as f32; }
    }
    for y in 0..height {
        for x in 0..width { dst[y * width + x] = temp[x * height + y]; }
    }
    0
}

fn downsample_box_reuse(src: &[f32], dst: &mut [f32], width: usize, height: usize, scale: usize) -> (usize, usize) {
    let dw = width.div_ceil(scale).max(1);
    let dh = height.div_ceil(scale).max(1);
    for y in 0..dh {
        let y0 = y * scale;
        let y1 = ((y + 1) * scale).min(height);
        for x in 0..dw {
            let x0 = x * scale;
            let x1 = ((x + 1) * scale).min(width);
            let mut sum = 0.0_f64;
            let mut count = 0usize;
            for yy in y0..y1 {
                for xx in x0..x1 { sum += src[yy * width + xx] as f64; count += 1; }
            }
            dst[y * dw + x] = (sum / count.max(1) as f64) as f32;
        }
    }
    (dw, dh)
}

fn upsample_bilinear_reuse(src: &[f32], sw: usize, sh: usize, dst: &mut [f32], dw: usize, dh: usize, scale: usize) {
    let inverse = 1.0_f64 / scale as f64;
    for y in 0..dh {
        let fy = (y as f64 + 0.5) * inverse - 0.5;
        let y0 = if fy < 0.0 { 0 } else if fy >= (sh - 1) as f64 { sh - 1 } else { fy.floor() as usize };
        let y1 = (y0 + 1).min(sh - 1);
        let ty = fy - y0 as f64;
        for x in 0..dw {
            let fx = (x as f64 + 0.5) * inverse - 0.5;
            let x0 = if fx < 0.0 { 0 } else if fx >= (sw - 1) as f64 { sw - 1 } else { fx.floor() as usize };
            let x1 = (x0 + 1).min(sw - 1);
            let tx = fx - x0 as f64;
            let top = src[y0 * sw + x0] as f64 + (src[y0 * sw + x1] as f64 - src[y0 * sw + x0] as f64) * tx;
            let bottom = src[y1 * sw + x0] as f64 + (src[y1 * sw + x1] as f64 - src[y1 * sw + x0] as f64) * tx;
            dst[y * dw + x] = (top + (bottom - top) * ty) as f32;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn blur_at_scale_reuse(
    src: &[f32], dst: &mut [f32], full_temp_a: &mut [f32], full_temp_b: &mut [f32],
    low_src: &mut [f32], low_dst: &mut [f32], low_temp_a: &mut [f32], low_temp_b: &mut [f32],
    width: usize, height: usize, sigma: f32, scale: usize, fast: bool,
    kernel: &mut [f32], line: &mut [f64],
) -> i32 {
    if scale == 1 {
        if fast { box_blur3_reuse(src, dst, full_temp_a, full_temp_b, kernel, width, height, sigma); return 0; }
        if sigma < 0.4 { gaussian_once_reuse(src, full_temp_a, dst, width, height, sigma, kernel); return 0; }
        return vv_gaussian_reuse(src, dst, full_temp_a, width, height, sigma, line);
    }
    let (low_width, low_height) = downsample_box_reuse(src, low_src, width, height, scale);
    let low_n = low_width * low_height;
    let low_sigma = sigma / scale as f32;
    if fast {
        box_blur3_reuse(&low_src[..low_n], &mut low_dst[..low_n], &mut low_temp_a[..low_n], &mut low_temp_b[..low_n], kernel, low_width, low_height, low_sigma);
    } else if low_sigma < 0.4 {
        gaussian_once_reuse(&low_src[..low_n], &mut low_temp_a[..low_n], &mut low_dst[..low_n], low_width, low_height, low_sigma, kernel);
    } else {
        let code = vv_gaussian_reuse(&low_src[..low_n], &mut low_dst[..low_n], &mut low_temp_a[..low_n], low_width, low_height, low_sigma, line);
        if code != 0 { return code; }
    }
    upsample_bilinear_reuse(&low_dst[..low_n], low_width, low_height, dst, width, height, scale);
    0
}

#[allow(clippy::too_many_arguments)]
fn blur_at_scale_accumulate_planar(
    src: &[f32], dst: &mut [f32], work_out: &mut [f32], weight: f32,
    full_temp_a: &mut [f32], full_temp_b: &mut [f32],
    low_src: &mut [f32], low_dst: &mut [f32], low_temp_a: &mut [f32], low_temp_b: &mut [f32],
    width: usize, height: usize, sigma: f32, scale: usize, fast: bool,
    kernel: &mut [f32], line: &mut [f64],
) -> i32 {
    if scale == 1 {
        let code = blur_at_scale_reuse(src, work_out, full_temp_a, full_temp_b, low_src, low_dst, low_temp_a, low_temp_b, width, height, sigma, scale, fast, kernel, line);
        if code != 0 { return code; }
        for i in 0..width * height { dst[i] += work_out[i] * weight; }
        return 0;
    }
    let (low_width, low_height) = downsample_box_reuse(src, low_src, width, height, scale);
    let low_n = low_width * low_height;
    let low_sigma = sigma / scale as f32;
    if fast {
        box_blur3_reuse(&low_src[..low_n], &mut low_dst[..low_n], &mut low_temp_a[..low_n], &mut low_temp_b[..low_n], kernel, low_width, low_height, low_sigma);
    } else if low_sigma < 0.4 {
        gaussian_once_reuse(&low_src[..low_n], &mut low_temp_a[..low_n], &mut low_dst[..low_n], low_width, low_height, low_sigma, kernel);
    } else {
        let code = vv_gaussian_reuse(&low_src[..low_n], &mut low_dst[..low_n], &mut low_temp_a[..low_n], low_width, low_height, low_sigma, line);
        if code != 0 { return code; }
    }
    let inverse = 1.0_f64 / scale as f64;
    for y in 0..height {
        let fy = (y as f64 + 0.5) * inverse - 0.5;
        let y0 = if fy < 0.0 { 0 } else if fy >= (low_height - 1) as f64 { low_height - 1 } else { fy.floor() as usize };
        let y1 = (y0 + 1).min(low_height - 1);
        let ty = fy - y0 as f64;
        for x in 0..width {
            let fx = (x as f64 + 0.5) * inverse - 0.5;
            let x0 = if fx < 0.0 { 0 } else if fx >= (low_width - 1) as f64 { low_width - 1 } else { fx.floor() as usize };
            let x1 = (x0 + 1).min(low_width - 1);
            let tx = fx - x0 as f64;
            let top = low_dst[y0 * low_width + x0] as f64 + (low_dst[y0 * low_width + x1] as f64 - low_dst[y0 * low_width + x0] as f64) * tx;
            let bottom = low_dst[y1 * low_width + x0] as f64 + (low_dst[y1 * low_width + x1] as f64 - low_dst[y1 * low_width + x0] as f64) * tx;
            dst[y * width + x] += (top + (bottom - top) * ty) as f32 * weight;
        }
    }
    0
}

#[allow(clippy::too_many_arguments)]
fn blur_at_scale_accumulate_interleaved(
    src: &[f32], dst: &mut [f32], channel: usize, work_out: &mut [f32], weight: f32,
    full_temp_a: &mut [f32], full_temp_b: &mut [f32],
    low_src: &mut [f32], low_dst: &mut [f32], low_temp_a: &mut [f32], low_temp_b: &mut [f32],
    width: usize, height: usize, sigma: f32, scale: usize, fast: bool,
    kernel: &mut [f32], line: &mut [f64],
) -> i32 {
    if scale == 1 {
        let code = blur_at_scale_reuse(src, work_out, full_temp_a, full_temp_b, low_src, low_dst, low_temp_a, low_temp_b, width, height, sigma, scale, fast, kernel, line);
        if code != 0 { return code; }
        for i in 0..width * height { dst[i * 3 + channel] += work_out[i] * weight; }
        return 0;
    }
    let (low_width, low_height) = downsample_box_reuse(src, low_src, width, height, scale);
    let low_n = low_width * low_height;
    let low_sigma = sigma / scale as f32;
    if fast {
        box_blur3_reuse(&low_src[..low_n], &mut low_dst[..low_n], &mut low_temp_a[..low_n], &mut low_temp_b[..low_n], kernel, low_width, low_height, low_sigma);
    } else if low_sigma < 0.4 {
        gaussian_once_reuse(&low_src[..low_n], &mut low_temp_a[..low_n], &mut low_dst[..low_n], low_width, low_height, low_sigma, kernel);
    } else {
        let code = vv_gaussian_reuse(&low_src[..low_n], &mut low_dst[..low_n], &mut low_temp_a[..low_n], low_width, low_height, low_sigma, line);
        if code != 0 { return code; }
    }
    let inverse = 1.0_f64 / scale as f64;
    for y in 0..height {
        let fy = (y as f64 + 0.5) * inverse - 0.5;
        let y0 = if fy < 0.0 { 0 } else if fy >= (low_height - 1) as f64 { low_height - 1 } else { fy.floor() as usize };
        let y1 = (y0 + 1).min(low_height - 1);
        let ty = fy - y0 as f64;
        for x in 0..width {
            let fx = (x as f64 + 0.5) * inverse - 0.5;
            let x0 = if fx < 0.0 { 0 } else if fx >= (low_width - 1) as f64 { low_width - 1 } else { fx.floor() as usize };
            let x1 = (x0 + 1).min(low_width - 1);
            let tx = fx - x0 as f64;
            let top = low_dst[y0 * low_width + x0] as f64 + (low_dst[y0 * low_width + x1] as f64 - low_dst[y0 * low_width + x0] as f64) * tx;
            let bottom = low_dst[y1 * low_width + x0] as f64 + (low_dst[y1 * low_width + x1] as f64 - low_dst[y1 * low_width + x0] as f64) * tx;
            dst[(y * width + x) * 3 + channel] += (top + (bottom - top) * ty) as f32 * weight;
        }
    }
    0
}

fn execute_resident_defringe(state: &mut ResidentState, input_slot: usize, output_slot: usize, params_start: usize, params_end: usize) -> i32 {
    let command = &state.command[..state.command_len];
    let amount = object_f32(command, params_start, params_end, HASH_AMOUNT).unwrap_or(f32::NAN);
    let radius_px = object_f32(command, params_start, params_end, HASH_RADIUS_PX).unwrap_or(f32::NAN);
    let threshold = object_f32(command, params_start, params_end, HASH_THRESHOLD).unwrap_or(f32::NAN);
    let softness = object_f32(command, params_start, params_end, HASH_SOFTNESS).unwrap_or(f32::NAN);
    let edge_sensitivity = object_f32(command, params_start, params_end, HASH_EDGE_SENSITIVITY).unwrap_or(f32::NAN);
    let mask = match resident_mask(command, params_start, params_end) { Ok(value) => value, Err(code) => return code };
    if [amount, radius_px, threshold, softness, edge_sensitivity].iter().any(|value| !value.is_finite()) { return ERR_NONFINITE_PARAM; }
    let preview_scale = f32::from_le_bytes([command[44], command[45], command[46], command[47]]);
    let fast = u32::from_le_bytes([command[48], command[49], command[50], command[51]]) == 0;
    let radius = (radius_px * preview_scale.max(0.01)).max(0.05);
    let n = state.width * state.height;
    if state.scratch.len() < n * 7 { return ERR_CAPACITY; }
    let values = n * 3;
    let ResidentState { frame_a, frame_b, alpha, scratch, kernel, .. } = state;
    let (input, output): (&[f32], &mut [f32]) = match (input_slot, output_slot) {
        (0, 1) => (&frame_a[..values], &mut frame_b[..values]),
        (1, 0) => (&frame_b[..values], &mut frame_a[..values]),
        _ => return ERR_INVALID_PLAN,
    };
    let (y, rest) = scratch[..n * 7].split_at_mut(n);
    let (cg, rest) = rest.split_at_mut(n);
    let (y_blur, rest) = rest.split_at_mut(n);
    let (cg_blur, rest) = rest.split_at_mut(n);
    let (temp_a, rest) = rest.split_at_mut(n);
    let (temp_b, _mask_plane) = rest.split_at_mut(n);
    for i in 0..n {
        let p = i * 3;
        y[i] = (input[p] + 2.0 * input[p + 1] + input[p + 2]) * 0.25;
        cg[i] = (-input[p] + 2.0 * input[p + 1] - input[p + 2]) * 0.25;
    }
    if fast {
        box_blur3_reuse(y, y_blur, temp_a, temp_b, kernel, state.width, state.height, radius);
        box_blur3_reuse(cg, cg_blur, temp_a, temp_b, kernel, state.width, state.height, radius);
    } else {
        gaussian_once_reuse(y, temp_a, y_blur, state.width, state.height, radius, kernel);
        gaussian_once_reuse(cg, temp_a, cg_blur, state.width, state.height, radius, kernel);
    }
    for i in 0..n {
        let p = i * 3;
        let edge = (y[i] - y_blur[i]).abs();
        let fringe = (cg[i] - cg_blur[i]).abs();
        let edge_gate = resident_smoothstep(0.01 / edge_sensitivity, 0.08 / edge_sensitivity, edge);
        let chroma_gate = resident_smoothstep(threshold, threshold + softness, fringe);
        let local_mix = amount * edge_gate * chroma_gate * alpha[i].clamp(0.0, 1.0);
        let corrected_cg = cg[i] + (cg_blur[i] - cg[i]) * local_mix;
        let co = (input[p] - input[p + 2]) * 0.5;
        let effected = [y[i] - corrected_cg + co, y[i] + corrected_cg, y[i] - corrected_cg - co];
        let coverage = resident_mask_coverage(mask, input[p], input[p + 1], input[p + 2]);
        for channel in 0..3 { output[p + channel] = input[p + channel] + (effected[channel] - input[p + channel]) * coverage; }
    }
    state.current_slot = output_slot;
    0
}

fn bloom_lobe_scale(sigma: f32, lobe: usize) -> usize {
    match lobe {
        0 => 1,
        1 => if sigma >= 16.0 { 4 } else { 2 },
        _ => if sigma >= 32.0 { 8 } else { 4 },
    }
}

fn execute_resident_bloom(state: &mut ResidentState, input_slot: usize, output_slot: usize, params_start: usize, params_end: usize) -> i32 {
    let command = &state.command[..state.command_len];
    let threshold_ev = object_f32(command, params_start, params_end, HASH_THRESHOLD_EV).unwrap_or(f32::NAN);
    let softness_ev = object_f32(command, params_start, params_end, HASH_SOFTNESS_EV).unwrap_or(f32::NAN);
    let radius = object_f32(command, params_start, params_end, HASH_RADIUS).unwrap_or(f32::NAN);
    let amplify = object_f32(command, params_start, params_end, HASH_AMPLIFY).unwrap_or(f32::NAN);
    let saturation = object_f32(command, params_start, params_end, HASH_SATURATION).unwrap_or(f32::NAN);
    let save_lights = object_f32(command, params_start, params_end, HASH_SAVE_LIGHTS).unwrap_or(f32::NAN);
    let mask = match resident_mask(command, params_start, params_end) { Ok(value) => value, Err(code) => return code };
    if [threshold_ev, softness_ev, radius, amplify, saturation, save_lights].iter().any(|value| !value.is_finite()) { return ERR_NONFINITE_PARAM; }
    let full_width = u32::from_le_bytes([command[28], command[29], command[30], command[31]]) as f32;
    let full_height = u32::from_le_bytes([command[32], command[33], command[34], command[35]]) as f32;
    let preview_scale = f32::from_le_bytes([command[44], command[45], command[46], command[47]]);
    let fast = u32::from_le_bytes([command[48], command[49], command[50], command[51]]) == 0;
    let threshold_value = 0.18 * 2.0_f32.powf(threshold_ev);
    let gate_end = threshold_value * 2.0_f32.powf(softness_ev);
    let radius_px = radius * 0.01 * full_width.hypot(full_height) * preview_scale;
    let n = state.width * state.height;
    let values = n * 3;
    if state.scratch.len() < n * 10 || state.transient.len() < n * 3 { return ERR_CAPACITY; }
    let ResidentState { frame_a, frame_b, alpha, scratch, transient, kernel, line, .. } = state;
    let (input, output): (&[f32], &mut [f32]) = match (input_slot, output_slot) {
        (0, 1) => (&frame_a[..values], &mut frame_b[..values]),
        (1, 0) => (&frame_b[..values], &mut frame_a[..values]),
        _ => return ERR_INVALID_PLAN,
    };
    let contribution = &mut transient[..values];
    contribution.fill(0.0);
    let (source, rest) = scratch[..n * 10].split_at_mut(values);
    let (blurred, rest) = rest.split_at_mut(n);
    let (full_temp_a, rest) = rest.split_at_mut(n);
    let (full_temp_b, rest) = rest.split_at_mut(n);
    let (low_src, rest) = rest.split_at_mut(n);
    let (low_dst, rest) = rest.split_at_mut(n);
    let (low_temp_a, low_temp_b) = rest.split_at_mut(n);
    for i in 0..n {
        let p = i * 3;
        let a = alpha[i].clamp(0.0, 1.0);
        let gate = resident_smoothstep(threshold_value, gate_end, input[p].max(input[p + 1]).max(input[p + 2]));
        let sr = input[p].max(0.0) * gate * a;
        let sg = input[p + 1].max(0.0) * gate * a;
        let sb = input[p + 2].max(0.0) * gate * a;
        let sy = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
        source[i] = (sy + (sr - sy) * saturation).max(0.0);
        source[n + i] = (sy + (sg - sy) * saturation).max(0.0);
        source[2 * n + i] = (sy + (sb - sy) * saturation).max(0.0);
    }
    let ratios = [0.22_f32, 0.75, 2.4];
    let weights = [0.62_f32, 0.28, 0.10];
    if amplify != 0.0 {
        for channel in 0..3 {
            let source_plane = &source[channel * n..(channel + 1) * n];
            for lobe in 0..3 {
                let sigma = (radius_px * ratios[lobe]).max(0.05);
                let scale = bloom_lobe_scale(sigma, lobe);
                let code = blur_at_scale_accumulate_interleaved(
                    source_plane, contribution, channel, blurred, weights[lobe], full_temp_a, full_temp_b,
                    low_src, low_dst, low_temp_a, low_temp_b,
                    state.width, state.height, sigma, scale, fast, kernel, line,
                );
                if code != 0 { return code; }
            }
        }
    }
    for i in 0..n {
        let p = i * 3;
        let light_mask = resident_smoothstep(threshold_value, gate_end, input[p].max(input[p + 1]).max(input[p + 2]));
        let keep = 1.0 - save_lights * light_mask;
        let coverage = resident_mask_coverage(mask, input[p], input[p + 1], input[p + 2]);
        for channel in 0..3 {
            contribution[p + channel] *= amplify * keep * coverage;
            output[p + channel] = input[p + channel] + contribution[p + channel];
        }
    }
    state.bloom_base_slot = input_slot as i32;
    state.bloom_contribution_valid = true;
    state.current_slot = output_slot;
    0
}

fn execute_resident_highlight_protection(state: &mut ResidentState, input_slot: usize, output_slot: usize, params_start: usize, params_end: usize) -> i32 {
    if input_slot != output_slot { return ERR_INVALID_PLAN; }
    let command = &state.command[..state.command_len];
    let amount = object_f32(command, params_start, params_end, HASH_AMOUNT).unwrap_or(f32::NAN);
    let threshold_ev = object_f32(command, params_start, params_end, HASH_THRESHOLD_EV).unwrap_or(f32::NAN);
    let softness_ev = object_f32(command, params_start, params_end, HASH_SOFTNESS_EV).unwrap_or(f32::NAN);
    let mask = match resident_mask(command, params_start, params_end) { Ok(value) => value, Err(code) => return code };
    if [amount, threshold_ev, softness_ev].iter().any(|value| !value.is_finite()) { return ERR_NONFINITE_PARAM; }
    if state.bloom_base_slot < 0 || !state.bloom_contribution_valid {
        state.stats[4] = 1; // missingBloomContribution
        state.current_slot = output_slot;
        return 0;
    }
    let threshold = 0.18 * 2.0_f32.powf(threshold_ev);
    let gate_end = threshold * 2.0_f32.powf(softness_ev);
    let n = state.width * state.height;
    let values = n * 3;
    if state.transient.len() < values { return ERR_CAPACITY; }
    let contribution = &state.transient[..values];
    let base_slot = state.bloom_base_slot as usize;
    let (base, current): (&[f32], &mut [f32]) = match (base_slot, input_slot) {
        (0, 1) => (&state.frame_a[..values], &mut state.frame_b[..values]),
        (1, 0) => (&state.frame_b[..values], &mut state.frame_a[..values]),
        _ => return ERR_INVALID_PLAN,
    };
    for i in 0..n {
        let p = i * 3;
        let input_rgb = [current[p], current[p + 1], current[p + 2]];
        let protection = resident_smoothstep(threshold, gate_end, base[p].max(base[p + 1]).max(base[p + 2]));
        let keep = 1.0 - amount * protection;
        let coverage = resident_mask_coverage(mask, input_rgb[0], input_rgb[1], input_rgb[2]);
        for channel in 0..3 {
            let effected = base[p + channel] + contribution[p + channel] * keep;
            current[p + channel] = input_rgb[channel] + (effected - input_rgb[channel]) * coverage;
        }
    }
    state.current_slot = output_slot;
    0
}

fn halation_lobes(smoothness: f32, red_tail: f32, red: bool) -> [(f32, f32); 3] {
    let smooth = smoothness.clamp(0.0, 1.0);
    let shoulder_weight = 0.27 + 0.08 * smooth;
    let tail_weight = 0.08 + 0.14 * smooth;
    let mut lobes = [
        (0.22 + 0.10 * smooth, 1.0 - shoulder_weight - tail_weight),
        (0.62 + 0.25 * smooth, shoulder_weight),
        (1.35 + 0.55 * smooth, tail_weight),
    ];
    if red && red_tail > 0.0 {
        let tail = red_tail.clamp(0.0, 1.0);
        lobes[0].1 *= 1.0 - 0.34 * tail;
        lobes[1].1 *= 1.0 + 0.62 * tail;
        lobes[2].1 *= 1.0 + 1.90 * tail;
        lobes[1].0 *= 1.0 + 0.16 * tail;
        lobes[2].0 *= 1.0 + 0.42 * tail;
        let sum = lobes[0].1 + lobes[1].1 + lobes[2].1;
        for lobe in &mut lobes { lobe.1 /= sum; }
    }
    lobes
}

fn halation_scale(sigma: f32, core: bool, fast: bool) -> usize {
    if core { return 1; }
    let minimum = if fast { 3.0 } else { 4.0 };
    let mut scale = 1;
    for candidate in [2usize, 4, 8] {
        if sigma / candidate as f32 >= minimum { scale = candidate; }
    }
    scale
}

#[inline]
fn halation_screen_gain(base: f32) -> f32 {
    if base <= 0.0 { 1.0 } else if base < 1.0 { 1.0 - base } else { 1.0 / base.max(1.0) }
}

#[allow(clippy::too_many_arguments)]
fn halation_density_composite(r: f32, g: f32, b: f32, er: f32, eg: f32, eb: f32, density: f32, blue_compensation: f32) -> [f32; 3] {
    if density <= 0.0 || er <= 1e-12 { return [r + er, g + eg, b + eb]; }
    let red_excess = (er - eg.max(eb)).max(0.0);
    if red_excess <= 1e-12 { return [r + er, g + eg, b + eb]; }
    let base_peak = r.max(g).max(b).max(1e-8);
    let coolness = ((g.max(b) - r) / base_peak).clamp(0.0, 1.0);
    let energy = red_excess * (1.0 + 1.6 * blue_compensation * coolness);
    let base_y = (0.2126 * r + 0.7152 * g + 0.0722 * b).max(0.0);
    let highlight = resident_smoothstep(0.0, 1.0, (base_y - 0.70) / 0.35);
    let mix = (density * (1.0 - resident_fast_exp(-6.0 * energy)) * (1.0 - 0.86 * highlight)).min(0.78);
    let green_ratio = (eg / er.max(1e-8)).clamp(0.12, 0.38);
    let blue_ratio = (eb / er.max(1e-8)).clamp(0.035, 0.12);
    let target_luma = 0.2126 + 0.7152 * green_ratio + 0.0722 * blue_ratio;
    let target_r = (base_y / target_luma.max(1e-8)).min(base_y * 2.4 + 0.05);
    let target_g = target_r * green_ratio;
    let target_b = target_r * blue_ratio;
    let mut cr = r + (target_r - r) * mix;
    let mut cg = g + (target_g - g) * mix;
    let mut cb = b + (target_b - b) * mix;
    let colored_y = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
    let lift = (base_y - colored_y).max(0.0);
    cr += lift; cg += lift; cb += lift;
    [cr + er, cg + eg, cb + eb]
}

fn execute_resident_halation(state: &mut ResidentState, input_slot: usize, output_slot: usize, params_start: usize, params_end: usize) -> i32 {
    let command = &state.command[..state.command_len];
    macro_rules! value { ($hash:expr) => { object_f32(command, params_start, params_end, $hash).unwrap_or(f32::NAN) }; }
    let strength = value!(HASH_STRENGTH);
    let sigma = value!(HASH_SIGMA);
    let threshold = value!(HASH_THRESHOLD);
    let source_softness = value!(HASH_SOURCE_SOFTNESS);
    let background_threshold = value!(HASH_BACKGROUND_THRESHOLD);
    let background_softness = value!(HASH_BACKGROUND_SOFTNESS);
    let smoothness = value!(HASH_SMOOTHNESS);
    let source_impact = value!(HASH_SOURCE_IMPACT);
    let amplify = value!(HASH_AMPLIFY);
    let source_expansion = value!(HASH_SOURCE_EXPANSION);
    let red_tail = value!(HASH_RED_TAIL);
    let blue_compensation = value!(HASH_BLUE_COMPENSATION);
    let color_density = value!(HASH_COLOR_DENSITY);
    let interior_protection = value!(HASH_SOURCE_INTERIOR_PROTECTION);
    let hot_threshold = value!(HASH_HOT_SOURCE_THRESHOLD);
    let hot_core_strength = value!(HASH_HOT_CORE_STRENGTH);
    let global_source_threshold = value!(HASH_GLOBAL_SOURCE_THRESHOLD);
    let spectral_sensitivity = value!(HASH_SPECTRAL_SENSITIVITY);
    let red_layer_bias = value!(HASH_RED_LAYER_THRESHOLD_BIAS);
    let global_diffusion = value!(HASH_GLOBAL_DIFFUSION);
    let center_attenuation = value!(HASH_CENTER_ATTENUATION);
    let spill_mix = value!(HASH_SPILL_MIX);
    let redshift = object_array3_f32(command, params_start, params_end, HASH_REDSHIFT).unwrap_or([f32::NAN; 3]);
    let sigma_ratio = object_array3_f32(command, params_start, params_end, HASH_SIGMA_RATIO).unwrap_or([f32::NAN; 3]);
    let fast = object_string_eq(command, params_start, params_end, HASH_DIFFUSION_MODE, b"fast");
    let spill = object_string_eq(command, params_start, params_end, HASH_EXTRACTION, b"spill");
    let screen = object_string_eq(command, params_start, params_end, HASH_BLEND_MODE, b"screen");
    let mask = match resident_mask(command, params_start, params_end) { Ok(value) => value, Err(code) => return code };
    let scalars = [strength, sigma, threshold, source_softness, background_threshold, background_softness,
        smoothness, source_impact, amplify, source_expansion, red_tail, blue_compensation, color_density,
        interior_protection, hot_threshold, hot_core_strength, global_source_threshold, spectral_sensitivity,
        red_layer_bias, global_diffusion, center_attenuation, spill_mix];
    if scalars.iter().chain(redshift.iter()).chain(sigma_ratio.iter()).any(|value| !value.is_finite()) { return ERR_NONFINITE_PARAM; }
    let width = state.width;
    let height = state.height;
    let n = width * height;
    let values = n * 3;
    if state.scratch.len() < n * 19 { return ERR_CAPACITY; }
    let ResidentState { frame_a, frame_b, alpha, scratch, kernel, line, deque, .. } = state;
    let (input, output): (&[f32], &mut [f32]) = match (input_slot, output_slot) {
        (0, 1) => (&frame_a[..values], &mut frame_b[..values]),
        (1, 0) => (&frame_b[..values], &mut frame_a[..values]),
        _ => return ERR_INVALID_PLAN,
    };
    let extract_code = unsafe {
        resident_halation_extract::extract_compact(
            input.as_ptr(), alpha.as_ptr(), scratch.as_mut_ptr(), scratch.as_mut_ptr().add(n * 8),
            n as u32, width as u32, height as u32,
            0.2126, 0.7152, 0.0722,
            threshold as f64, source_softness as f64, background_threshold as f64, background_softness as f64,
            if spill { spill_mix as f64 } else { 0.0 }, source_impact as f64, hot_threshold as f64,
            spectral_sensitivity as f64, blue_compensation as f64, red_layer_bias as f64,
            source_expansion as f64, interior_protection as f64, sigma as f64, amplify as f64,
            deque,
        )
    };
    if extract_code != 0 { return ERR_INTERNAL; }
    let (extract, workspace) = scratch[..n * 19].split_at_mut(n * 8);
    let (luminance, extract_rest) = extract.split_at_mut(n);
    let (local_gate, extract_rest) = extract_rest.split_at_mut(n);
    let (density_gate, extract_rest) = extract_rest.split_at_mut(n);
    let (source_exposure, extract_rest) = extract_rest.split_at_mut(n);
    let (source_authorization, extract_rest) = extract_rest.split_at_mut(n);
    let (source_r, extract_rest) = extract_rest.split_at_mut(n);
    let (source_g, source_b) = extract_rest.split_at_mut(n);
    let (diffuse, workspace) = workspace.split_at_mut(values);
    let (full_temp_a, workspace) = workspace.split_at_mut(n);
    let (full_temp_b, workspace) = workspace.split_at_mut(n);
    let (low_src, workspace) = workspace.split_at_mut(n);
    let (low_dst, workspace) = workspace.split_at_mut(n);
    let (low_temp_a, workspace) = workspace.split_at_mut(n);
    let (low_temp_b, workspace) = workspace.split_at_mut(n);
    let (lobe_out, workspace) = workspace.split_at_mut(n);
    let (environment, workspace) = workspace.split_at_mut(n);
    if !workspace.is_empty() { return ERR_INTERNAL; }

    for channel in 0..3 {
        let source: &[f32] = match channel { 0 => source_r, 1 => source_g, _ => source_b };
        let channel_sigma = sigma * sigma_ratio[channel];
        let lobes = halation_lobes(smoothness, red_tail, channel == 0);
        let destination = &mut diffuse[channel * n..(channel + 1) * n];
        for (lobe_index, (ratio, weight)) in lobes.iter().copied().enumerate() {
            let lobe_sigma = channel_sigma * ratio;
            let scale = halation_scale(lobe_sigma, lobe_index == 0, fast);
            if lobe_index == 0 {
                let code = blur_at_scale_reuse(source, destination, full_temp_a, full_temp_b, low_src, low_dst, low_temp_a, low_temp_b, width, height, lobe_sigma, scale, fast, kernel, line);
                if code != 0 { return code; }
                for value in destination.iter_mut() { *value *= weight; }
            } else {
                let code = blur_at_scale_accumulate_planar(source, destination, lobe_out, weight, full_temp_a, full_temp_b, low_src, low_dst, low_temp_a, low_temp_b, width, height, lobe_sigma, scale, fast, kernel, line);
                if code != 0 { return code; }
            }
        }
        for value in destination.iter_mut() { *value *= redshift[channel]; }
    }

    let source_envelope = lobe_out;
    source_envelope.fill(0.0);
    environment.fill(0.0);
    density_gate.fill(1.0);
    if interior_protection > 0.0 {
        let envelope_sigma = (sigma * 0.7).max(0.5);
        let code = blur_at_scale_reuse(source_r, source_envelope, full_temp_a, full_temp_b, low_src, low_dst, low_temp_a, low_temp_b, width, height, envelope_sigma, 1, fast, kernel, line);
        if code != 0 { return code; }
        let context_sigma = (sigma * 1.25).max(2.0);
        let context_scale = halation_scale(context_sigma, false, fast);
        let code = blur_at_scale_reuse(luminance, environment, full_temp_a, full_temp_b, low_src, low_dst, low_temp_a, low_temp_b, width, height, context_sigma, context_scale, fast, kernel, line);
        if code != 0 { return code; }
        if color_density > 0.0 {
            let normalize = amplify.max(1.0);
            for i in 0..n {
                let protected = source_r[i].max(source_envelope[i]);
                let body = resident_smoothstep(0.015, 0.08, protected / normalize);
                density_gate[i] = 1.0 - interior_protection * body;
            }
        }
    }

    for i in 0..n {
        let p = i * 3;
        let hot_mix = resident_smoothstep(hot_threshold - 0.25, hot_threshold + 0.25, source_exposure[i]);
        let hot_attenuation = (1.0 - hot_core_strength).powi(3);
        let attenuation = center_attenuation * (1.0 - hot_mix + hot_mix * hot_attenuation);
        let legacy = [
            (diffuse[i] - attenuation * source_r[i]).max(0.0),
            (diffuse[n + i] - attenuation * source_g[i]).max(0.0),
            (diffuse[2 * n + i] - attenuation * source_b[i]).max(0.0),
        ];
        let mut potential = legacy;
        let gate_relief;
        if interior_protection > 0.0 {
            let peak = source_r[i];
            let envelope_ratio = if peak > 1e-8 { (source_envelope[i] / peak).min(1.0) } else { 1.0 };
            let dark_environment = 1.0 - resident_smoothstep(0.32, 0.62, environment[i]);
            let compact_shape = 1.0 - resident_smoothstep(0.22, 0.72, envelope_ratio);
            let expanded = source_authorization[i].clamp(0.0, 1.0);
            let authorization = (hot_mix * compact_shape).max(expanded);
            let source_body = resident_smoothstep(0.04, 0.42, source_exposure[i]);
            let gate_compact = authorization * dark_environment;
            let potential_compact = gate_compact * (1.0 - source_body);
            let effective_protection = interior_protection * (1.0 - potential_compact);
            let edge = [
                (diffuse[i] - redshift[0] * source_r[i]).max(0.0),
                (diffuse[n + i] - redshift[1] * source_g[i]).max(0.0),
                (diffuse[2 * n + i] - redshift[2] * source_b[i]).max(0.0),
            ];
            for channel in 0..3 { potential[channel] = legacy[channel] * (1.0 - effective_protection) + edge[channel] * effective_protection; }
            let legacy_relief = (hot_mix * hot_core_strength).max((1.0 - resident_fast_exp(-legacy[0] * 48.0)) * hot_core_strength);
            let reflective = resident_smoothstep(0.45, 0.72, luminance[i]) * resident_smoothstep(0.38, 0.68, environment[i]);
            let edge_relief = (1.0 - resident_fast_exp(-edge[0] * 48.0)) * hot_core_strength * (1.0 - reflective);
            let effective_gate_protection = interior_protection * (1.0 - gate_compact);
            gate_relief = legacy_relief * (1.0 - effective_gate_protection) + edge_relief * effective_gate_protection;
        } else {
            gate_relief = (hot_mix * hot_core_strength).max((1.0 - resident_fast_exp(-potential[0] * 48.0)) * hot_core_strength);
        }
        let gate = local_gate[i] + (1.0 - local_gate[i]) * gate_relief;
        let mut target_preserve = 0.0_f32;
        if interior_protection > 0.0 && spectral_sensitivity > 0.0 {
            let (saturation_value, red_response, _, _) = resident_halation_extract::spectral_hue_response(input[p].max(0.0) as f64, input[p + 1].max(0.0) as f64, input[p + 2].max(0.0) as f64);
            let purity = resident_smoothstep(0.35, 0.80, saturation_value as f32);
            let blue_cyan = 1.0 - resident_smoothstep(0.02, 0.25, (red_response as f32).clamp(0.0, 1.0));
            let emissive = resident_smoothstep(0.28, 0.72, input[p].max(input[p + 1]).max(input[p + 2]).max(0.0));
            target_preserve = purity * blue_cyan * emissive * resident_smoothstep(0.0, 1.0, spectral_sensitivity);
        }
        let target = gate * (1.0 - target_preserve);
        output[p] = potential[0] * target;
        output[p + 1] = potential[1] * target;
        output[p + 2] = potential[2] * target;
    }

    if global_diffusion > 0.0 {
        let (global_source, diffuse_rest) = diffuse.split_at_mut(n);
        let (global_out, _) = diffuse_rest.split_at_mut(n);
        for i in 0..n {
            let source_gate = resident_smoothstep(global_source_threshold - 0.25, global_source_threshold + 0.25, source_exposure[i]);
            global_source[i] = (source_r[i] * 0.88 + source_g[i] * 0.12) * source_gate;
        }
        let broad_sigma = (sigma * 4.0).max(12.0);
        let broad_scale = halation_scale(broad_sigma, false, fast);
        let code = blur_at_scale_reuse(global_source, global_out, full_temp_a, full_temp_b, low_src, low_dst, low_temp_a, low_temp_b, width, height, broad_sigma, broad_scale, fast, kernel, line);
        if code != 0 { return code; }
        for i in 0..n {
            let y = luminance[i].max(0.0);
            let gate = resident_smoothstep(0.03, 0.3, y) * (1.0 - resident_smoothstep(0.75, 1.8, y));
            let aggregate = (1.0 - resident_fast_exp(-global_out[i].max(0.0) * 0.75)) / 0.75;
            let value = aggregate * global_diffusion * gate;
            let p = i * 3;
            output[p] += value; output[p + 1] += value * 0.12; output[p + 2] += value * 0.025;
        }
    }

    let effect_alpha = strength / 100.0 * 2.0;
    for i in 0..n {
        let p = i * 3;
        let gains = if screen {
            [halation_screen_gain(input[p]), halation_screen_gain(input[p + 1]), halation_screen_gain(input[p + 2])]
        } else { [1.0; 3] };
        let er = output[p].max(0.0) * effect_alpha * gains[0];
        let eg = output[p + 1].max(0.0) * effect_alpha * gains[1];
        let eb = output[p + 2].max(0.0) * effect_alpha * gains[2];
        let effected = halation_density_composite(input[p], input[p + 1], input[p + 2], er, eg, eb, color_density.clamp(0.0, 1.0) * density_gate[i], blue_compensation.clamp(0.0, 1.0));
        let coverage = resident_mask_coverage(mask, input[p], input[p + 1], input[p + 2]);
        for channel in 0..3 { output[p + channel] = input[p + channel] + (effected[channel] - input[p + channel]) * coverage; }
    }
    state.current_slot = output_slot;
    0
}

fn execute_resident_resolution(state: &mut ResidentState, input_slot: usize, output_slot: usize, params_start: usize, params_end: usize) -> i32 {
    let command = &state.command[..state.command_len];
    let amount = object_f32(command, params_start, params_end, HASH_AMOUNT).unwrap_or(f32::NAN);
    let response = object_f32(command, params_start, params_end, HASH_RESPONSE).unwrap_or(f32::NAN);
    let toe_loss = object_f32(command, params_start, params_end, HASH_TOE_LOSS).unwrap_or(f32::NAN);
    let shoulder_loss = object_f32(command, params_start, params_end, HASH_SHOULDER_LOSS).unwrap_or(f32::NAN);
    let positive = object_string_eq(command, params_start, params_end, HASH_PROFILE, b"positive");
    let mask = match resident_mask(command, params_start, params_end) { Ok(value) => value, Err(code) => return code };
    if [amount, response, toe_loss, shoulder_loss].iter().any(|value| !value.is_finite()) { return ERR_NONFINITE_PARAM; }
    let full_width = u32::from_le_bytes([command[28], command[29], command[30], command[31]]) as f32;
    let preview_scale = f32::from_le_bytes([command[44], command[45], command[46], command[47]]);
    let quality = u32::from_le_bytes([command[48], command[49], command[50], command[51]]);
    let format_id = u32::from_le_bytes([command[56], command[57], command[58], command[59]]);
    let iso = u32::from_le_bytes([command[60], command[61], command[62], command[63]]).max(1) as f32;
    let aperture_width = match format_id { 1 => 5.79, 2 => 12.52, 4 => 52.15, _ => 24.89 };
    let base = if positive { 42.0_f32 } else { 56.0_f32 };
    let iso_factor = (250.0_f32 / iso).powf(0.10).clamp(0.75, 1.25);
    let f50_mm = (base * iso_factor * response).clamp(12.0, 120.0);
    let f50_px = f50_mm / (full_width / aperture_width);
    let sigma = (std::f32::consts::LN_2.sqrt() / (2.0_f32.sqrt() * std::f32::consts::PI * f50_px.max(1e-4))) * preview_scale;
    if sigma < 0.15 { return copy_resident_slot(state, input_slot, output_slot); }

    let n = state.width * state.height;
    let values = n * 3;
    let ResidentState { frame_a, frame_b, scratch, kernel, .. } = state;
    let (input, output): (&[f32], &mut [f32]) = match (input_slot, output_slot) {
        (0, 1) => (&frame_a[..values], &mut frame_b[..values]),
        (1, 0) => (&frame_b[..values], &mut frame_a[..values]),
        _ => return ERR_INVALID_PLAN,
    };
    let (weights, rest) = scratch[..n * 6].split_at_mut(n);
    let (source, rest) = rest.split_at_mut(n);
    let (first, rest) = rest.split_at_mut(n);
    let (wide, rest) = rest.split_at_mut(n);
    let (temp_a, temp_b) = rest.split_at_mut(n);
    let mut needs_wide = false;
    for i in 0..n {
        let p = i * 3;
        let luminance = (0.2126 * input[p] + 0.7152 * input[p + 1] + 0.0722 * input[p + 2]).max(1e-6);
        let exposure = resident_fast_log2(luminance / 0.18);
        let toe = 1.0 - resident_smoothstep(-6.0, -2.0, exposure);
        let shoulder = resident_smoothstep(2.0, 6.0, exposure);
        let weight = (amount * (1.0 + toe_loss * toe + shoulder_loss * shoulder)).clamp(0.0, 1.5);
        weights[i] = weight;
        needs_wide |= weight > 1.0;
    }
    for channel in 0..3 {
        for i in 0..n { source[i] = input[i * 3 + channel]; }
        if quality == 0 {
            box_blur3_reuse(source, first, temp_a, temp_b, kernel, state.width, state.height, sigma);
            if needs_wide { box_blur3_reuse(source, wide, temp_a, temp_b, kernel, state.width, state.height, sigma * 2.2); }
        } else {
            gaussian_once_reuse(source, temp_a, first, state.width, state.height, sigma, kernel);
            if needs_wide { gaussian_once_reuse(source, temp_a, wide, state.width, state.height, sigma * 2.2, kernel); }
        }
        for i in 0..n {
            let weight = weights[i];
            let source_value = source[i];
            let effected = if weight <= 1.0 {
                source_value + weight * (first[i] - source_value)
            } else {
                (2.0 - weight) * first[i] + (weight - 1.0) * wide[i]
            };
            let p = i * 3;
            let coverage = resident_mask_coverage(mask, input[p], input[p + 1], input[p + 2]);
            output[p + channel] = input[p + channel] + (effected - input[p + channel]) * coverage;
        }
    }
    state.current_slot = output_slot;
    0
}

fn resident_gaussian_variance_scale(sigma: f32, kernel_storage: &mut [f32]) -> Option<f32> {
    if sigma < 0.15 { return Some(1.0); }
    let radius = gaussian_radius(sigma);
    let size = radius.checked_mul(2)?.checked_add(1)?;
    if size > kernel_storage.len() { return None; }
    let kernel = &mut kernel_storage[..size];
    let denominator = 2.0 * sigma * sigma;
    let mut sum = 0.0_f32;
    for (index, value) in kernel.iter_mut().enumerate() {
        let offset = index as isize - radius as isize;
        *value = (-(offset * offset) as f32 / denominator).exp();
        sum += *value;
    }
    let mut l2 = 0.0_f64;
    for value in kernel.iter_mut() {
        *value /= sum;
        l2 += (*value as f64) * (*value as f64);
    }
    Some(if l2 > 0.0 { (1.0 / l2) as f32 } else { 1.0 })
}

fn resident_box_variance_scale(sigma: f32) -> f32 {
    if sigma < 0.15 { return 1.0; }
    let radius = radius_for_sigma(sigma);
    if radius == 0 { return 1.0; }
    let width = radius * 2 + 1;
    let width_f64 = width as f64;
    let denominator = width_f64 * width_f64 * width_f64;
    let mut l2 = 0.0_f64;
    // The coefficient of three identical box kernels is the sum of a
    // triangular two-box kernel across one box window.  Evaluate its L2 norm
    // directly so the resident hot path never allocates a temporary Vec.
    for k in 0..=(3 * (width - 1)) {
        let start = k.saturating_sub(width - 1);
        let end = k.min(2 * (width - 1));
        let mut coefficient = 0_usize;
        for index in start..=end {
            coefficient += if index < width { index + 1 } else { 2 * width - 1 - index };
        }
        let normalized = coefficient as f64 / denominator;
        l2 += normalized * normalized;
    }
    if l2 > 0.0 { (1.0 / l2) as f32 } else { 1.0 }
}

fn execute_resident_grain(state: &mut ResidentState, input_slot: usize, output_slot: usize, params_start: usize, params_end: usize, node_hash: u32) -> i32 {
    let command = &state.command[..state.command_len];
    let amount = object_f32(command, params_start, params_end, HASH_AMOUNT).unwrap_or(f32::NAN);
    let size = object_f32(command, params_start, params_end, HASH_SIZE).unwrap_or(f32::NAN);
    let roughness = object_f32(command, params_start, params_end, HASH_ROUGHNESS).unwrap_or(f32::NAN);
    let chroma = object_f32(command, params_start, params_end, HASH_CHROMA).unwrap_or(f32::NAN);
    let seed = object_u32(command, params_start, params_end, HASH_SEED).unwrap_or(0);
    let analogue = object_string_eq(command, params_start, params_end, HASH_MODE, b"analogue");
    let fast_mode = object_string_eq(command, params_start, params_end, HASH_MODE, b"fast");
    let positive = object_string_eq(command, params_start, params_end, HASH_PROFILE, b"positive");
    let mask = match resident_mask(command, params_start, params_end) { Ok(value) => value, Err(code) => return code };
    if [amount, size, roughness, chroma].iter().any(|value| !value.is_finite()) || (!analogue && !fast_mode) { return ERR_UNSUPPORTED_NODE; }
    let full_width = u32::from_le_bytes([command[28], command[29], command[30], command[31]]) as f32;
    let origin_x = i32::from_le_bytes([command[36], command[37], command[38], command[39]]) as f32;
    let origin_y = i32::from_le_bytes([command[40], command[41], command[42], command[43]]) as f32;
    let preview_scale = f32::from_le_bytes([command[44], command[45], command[46], command[47]]);
    let quality = u32::from_le_bytes([command[48], command[49], command[50], command[51]]);
    let format_id = u32::from_le_bytes([command[56], command[57], command[58], command[59]]);
    let iso = u32::from_le_bytes([command[60], command[61], command[62], command[63]]).max(1) as f32;
    let aperture_width = match format_id { 1 => 5.79, 2 => 12.52, 4 => 52.15, _ => 24.89 };
    let iso_size = (iso / 250.0).powf(0.28).clamp(0.65, 2.2);
    let base_px = 7.5 * iso_size * size * (full_width / aperture_width) / 1000.0 * preview_scale;
    let physical_sigmas = [0.65 * base_px / 2.35482, 1.35 * base_px / 2.35482, 2.80 * base_px / 2.35482];
    let fine = 0.295 + 0.300 * roughness;
    let medium = 0.380;
    let coarse = 0.325 - 0.300 * roughness;
    let mut sigmas = physical_sigmas;
    let mut weights = [fine, medium, coarse];
    let scale_count = if fast_mode {
        sigmas[0] = ((fine * physical_sigmas[0].powi(2) + medium * physical_sigmas[1].powi(2)) / (fine + medium)).sqrt();
        sigmas[1] = physical_sigmas[2];
        weights[0] = fine + medium;
        weights[1] = coarse;
        2
    } else { 3 };
    let field_scale = if quality == 0 {
        if preview_scale < 0.25 { 4 } else if preview_scale < 1.0 { 2 } else { 1 }
    } else if preview_scale == 1.0 && full_width >= 4096.0 { 2 } else { 1 };
    let field_preview_scale = preview_scale / field_scale as f32;
    let low_sigmas = [sigmas[0] / field_scale as f32, sigmas[1] / field_scale as f32, sigmas[2] / field_scale as f32];
    let max_pad = low_sigmas[..scale_count].iter().map(|sigma| if fast_mode { radius_for_sigma(*sigma) * 3 } else { gaussian_radius(*sigma) }).max().unwrap_or(0);
    let width = state.width;
    let height = state.height;
    let n = width * height;
    let field_width = width.div_ceil(field_scale) + 2 * max_pad;
    let field_height = height.div_ceil(field_scale) + 2 * max_pad;
    let field_pixels = match field_width.checked_mul(field_height) { Some(value) => value, None => return ERR_CAPACITY };
    let required = match n.checked_mul(3).and_then(|value| value.checked_add(field_pixels.checked_mul(7)?)) { Some(value) => value, None => return ERR_CAPACITY };
    if required > state.scratch.len() { return ERR_CAPACITY; }
    let values = n * 3;
    let ResidentState { frame_a, frame_b, alpha, scratch, kernel, .. } = state;
    let (input, output): (&[f32], &mut [f32]) = match (input_slot, output_slot) {
        (0, 1) => (&frame_a[..values], &mut frame_b[..values]),
        (1, 0) => (&frame_b[..values], &mut frame_a[..values]),
        _ => return ERR_INVALID_PLAN,
    };
    output.copy_from_slice(input);
    let (accum, workspace) = scratch[..required].split_at_mut(n * 3);
    accum.fill(0.0);
    let (raw_fields, blur_scratch) = workspace.split_at_mut(field_pixels * 4);
    let (destination, blur_scratch) = blur_scratch.split_at_mut(field_pixels);
    let (temp_a, temp_b) = blur_scratch.split_at_mut(field_pixels);
    let shared_weight = (1.0 - 0.18 * chroma).sqrt();
    let independent_weight = (0.18 * chroma).sqrt();
    let field_origin_x = origin_x - max_pad as f32 / field_preview_scale;
    let field_origin_y = origin_y - max_pad as f32 / field_preview_scale;
    let grain_node_prefix = fmix32(fmix32(seed ^ 0x9e37_79b9) ^ node_hash);
    let exact_stride = if preview_scale == 1.0 { Some(field_scale as i32) } else { None };
    let exact_origin_x = origin_x as i32 - max_pad as i32 * field_scale as i32;
    let exact_origin_y = origin_y as i32 - max_pad as i32 * field_scale as i32;
    for scale_index in 0..scale_count {
        let normalization = if fast_mode {
            resident_box_variance_scale(low_sigmas[scale_index])
        } else {
            match resident_gaussian_variance_scale(low_sigmas[scale_index], kernel) {
                Some(value) => value,
                None => return ERR_CAPACITY,
            }
        };
        let shared_coefficient = weights[scale_index].sqrt() * shared_weight * normalization;
        let independent_coefficient = weights[scale_index].sqrt() * independent_weight * normalization;
        for y in 0..field_height {
            let absolute_y = match exact_stride {
                Some(stride) => exact_origin_y.wrapping_add((y as i32).wrapping_mul(stride)),
                None => (field_origin_y + y as f32 / field_preview_scale).floor() as i32,
            };
            for x in 0..field_width {
                let absolute_x = match exact_stride {
                    Some(stride) => exact_origin_x.wrapping_add((x as i32).wrapping_mul(stride)),
                    None => (field_origin_x + x as f32 / field_preview_scale).floor() as i32,
                };
                let prefix = hash_coordinate_prefix_from_node(grain_node_prefix, absolute_x, absolute_y, scale_index as u32);
                let index = y * field_width + x;
                for channel in 0..4 {
                    raw_fields[channel * field_pixels + index] = gaussian_from_channel_prefix(prefix, channel as u32);
                }
            }
        }
        for channel in 0..4 {
            if low_sigmas[scale_index] < 0.15 { continue; }
            let start = channel * field_pixels;
            let end = start + field_pixels;
            {
                let source = &raw_fields[start..end];
                if fast_mode {
                    box_blur3_reuse(source, destination, temp_a, temp_b, kernel, field_width, field_height, low_sigmas[scale_index]);
                } else {
                    gaussian_once_reuse(source, temp_a, destination, field_width, field_height, low_sigmas[scale_index], kernel);
                }
            }
            raw_fields[start..end].copy_from_slice(&destination[..field_pixels]);
        }
        let status = accumulate_grain_fields_values(
            accum,
            raw_fields,
            width,
            height,
            field_width,
            field_height,
            max_pad,
            field_scale,
            shared_coefficient,
            independent_coefficient,
        );
        if status != 0 { return status; }
    }
    for i in 0..n {
        let p = i * 3;
        let luminance = (0.2126 * output[p] + 0.7152 * output[p + 1] + 0.0722 * output[p + 2]).max(1e-6);
        let exposure = resident_fast_log2(luminance / 0.18);
        let envelope = if positive {
            0.35 + 0.75 * resident_fast_exp(-0.5 * ((exposure - 0.3) / 1.4).powi(2))
        } else {
            0.42 + 0.58 * resident_fast_exp(-0.5 * ((exposure + 0.5) / 2.0).powi(2))
        };
        let sigma_d = 0.085 * amount * (iso / 250.0).sqrt() * envelope;
        let variance = (std::f32::consts::LN_2 * sigma_d).powi(2);
        let mix_value = alpha[i];
        for channel in 0..3 {
            let log_gain = (std::f32::consts::LN_2 * sigma_d * accum[channel * n + i] - 0.5 * variance).clamp(-20.0, 20.0);
            let gain = resident_fast_exp(log_gain);
            let original = output[p + channel];
            output[p + channel] = original + mix_value * (original * gain - original);
        }
        let coverage = resident_mask_coverage(mask, input[p], input[p + 1], input[p + 2]);
        for channel in 0..3 { output[p + channel] = input[p + channel] + (output[p + channel] - input[p + channel]) * coverage; }
    }
    state.current_slot = output_slot;
    0
}

#[derive(Clone, Copy)]
struct VvCoefficients {
    b0: f64,
    b1: f64,
    b2: f64,
    b3: f64,
    b: f64,
}

fn vv_coefficients(sigma: f64) -> VvCoefficients {
    let q = if sigma >= 2.5 {
        0.98711 * sigma - 0.9633
    } else {
        3.97156 - 4.14554 * (1.0 - 0.26891 * sigma).max(0.0).sqrt()
    };
    let q2 = q * q;
    let q3 = q2 * q;
    let b0 = 1.57825 + 2.44413 * q + 1.4281 * q2 + 0.422205 * q3;
    let b1 = 2.44413 * q + 2.85619 * q2 + 1.26661 * q3;
    let b2 = -(1.4281 * q2 + 1.26661 * q3);
    let b3 = 0.422205 * q3;
    let b = 1.0 - (b1 + b2 + b3) / b0;
    VvCoefficients { b0, b1, b2, b3, b }
}

fn vv_one_dimensional(buffer: &mut [f64], coefficients: VvCoefficients) {
    let mut y1 = 0.0_f64;
    let mut y2 = 0.0_f64;
    let mut y3 = 0.0_f64;
    let inv_b0 = 1.0 / coefficients.b0;
    for value in buffer.iter_mut() {
        let output = coefficients.b * *value
            + (coefficients.b1 * y1 + coefficients.b2 * y2 + coefficients.b3 * y3) * inv_b0;
        y3 = y2;
        y2 = y1;
        y1 = output;
        *value = output;
    }
    y1 = 0.0;
    y2 = 0.0;
    y3 = 0.0;
    for value in buffer.iter_mut().rev() {
        let output = coefficients.b * *value
            + (coefficients.b1 * y1 + coefficients.b2 * y2 + coefficients.b3 * y3) * inv_b0;
        y3 = y2;
        y2 = y1;
        y1 = output;
        *value = output;
    }
}

/// Run the same double-precision van Vliet-Young recursive Gaussian used by
/// the JavaScript Quality reference. The ABI still stores f32 planes; f64
/// line buffers keep the reference rounding close enough for the strict
/// primitive regression tolerance.
#[no_mangle]
pub unsafe extern "C" fn film_vv_gaussian_blur_f32(
    pointer: *mut f32,
    pixels: u32,
    width: u32,
    height: u32,
    sigma: f32,
) -> i32 {
    if pointer.is_null()
        || width == 0
        || height == 0
        || width.checked_mul(height) != Some(pixels)
        || !sigma.is_finite()
        || sigma < 0.0
    {
        return -1;
    }
    let w = width as usize;
    let h = height as usize;
    let n = pixels as usize;
    let all = slice::from_raw_parts_mut(pointer, n * 4);
    let (source, rest) = all.split_at_mut(n);
    let (destination, rest) = rest.split_at_mut(n);
    let (temp, _unused) = rest.split_at_mut(n);
    let sigma = sigma as f64;
    let pad = (5.0 * sigma).ceil().max(2.0) as usize;
    let coefficients = vv_coefficients(sigma);
    let mut row = vec![0.0_f64; w + 2 * pad];
    let mut column = vec![0.0_f64; h + 2 * pad];

    for y in 0..h {
        let base = y * w;
        for x in 0..w {
            row[x + pad] = source[base + x] as f64;
        }
        for k in 1..=pad {
            row[pad - k] = source[base + k.min(w - 1)] as f64;
            row[pad + w - 1 + k] = source[base + (w - 1).saturating_sub(k)] as f64;
        }
        vv_one_dimensional(&mut row, coefficients);
        for x in 0..w {
            temp[base + x] = row[x + pad] as f32;
        }
    }
    for x in 0..w {
        for y in 0..h {
            column[y + pad] = temp[y * w + x] as f64;
        }
        for k in 1..=pad {
            column[pad - k] = temp[k.min(h - 1) * w + x] as f64;
            column[pad + h - 1 + k] = temp[(h - 1).saturating_sub(k) * w + x] as f64;
        }
        vv_one_dimensional(&mut column, coefficients);
        for y in 0..h {
            destination[y * w + x] = column[y + pad] as f32;
        }
    }
    0
}

#[inline(always)]
fn fmix32(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(0x85eb_ca6b);
    value ^= value >> 13;
    value = value.wrapping_mul(0xc2b2_ae35);
    value ^ (value >> 16)
}

#[inline(always)]
fn hash_coordinate_prefix(seed: u32, node_hash: u32, x: i32, y: i32, scale: u32) -> u32 {
    hash_coordinate_prefix_from_node(fmix32(fmix32(seed ^ 0x9e37_79b9) ^ node_hash), x, y, scale)
}

#[inline(always)]
fn hash_coordinate_prefix_from_node(node_prefix: u32, x: i32, y: i32, scale: u32) -> u32 {
    let mut prefix = node_prefix;
    for word in [x as u32, y as u32, scale] {
        prefix = fmix32(prefix ^ word);
    }
    prefix
}

#[inline(always)]
fn gaussian_from_channel_prefix(prefix: u32, channel: u32) -> f32 {
    let channel_prefix = fmix32(prefix ^ channel);
    let mut sum = 0.0_f32;
    for sample in 0..12 { sum += fmix32(channel_prefix ^ sample) as f32 / 4294967296.0_f32; }
    sum - 6.0_f32
}

#[inline(always)]
fn gaussian_from_hash(seed: u32, node_hash: u32, x: i32, y: i32, scale: u32, channel: u32) -> f32 {
    gaussian_from_channel_prefix(hash_coordinate_prefix(seed, node_hash, x, y, scale), channel)
}

/// Gaussian blur ABI. The allocation contains source, destination and two scratch planes.
#[no_mangle]
pub unsafe extern "C" fn film_gaussian_blur_f32(pointer: *mut f32, pixels: u32, width: u32, height: u32, sigma: f32) -> i32 {
    if pointer.is_null() || width == 0 || height == 0 || width.checked_mul(height) != Some(pixels) || !sigma.is_finite() || sigma < 0.0 { return -1; }
    let n = pixels as usize;
    let all = slice::from_raw_parts_mut(pointer, n * 4);
    let (source, rest) = all.split_at_mut(n);
    let (destination, rest) = rest.split_at_mut(n);
    let (temp_a, _temp_b) = rest.split_at_mut(n);
    gaussian_once(source, temp_a, destination, width as usize, height as usize, sigma);
    0
}

/// Fill a coordinate-addressed twelve-uniform Gaussian field in-place.
#[no_mangle]
pub unsafe extern "C" fn film_hash_field_f32(pointer: *mut f32, pixels: u32, width: u32, height: u32, seed: u32, node_hash: u32, origin_x: i32, origin_y: i32, scale: u32, channel: u32) -> i32 {
    if pointer.is_null() || width == 0 || height == 0 || width.checked_mul(height) != Some(pixels) { return -1; }
    let output = slice::from_raw_parts_mut(pointer, pixels as usize);
    for y in 0..height as usize {
        for x in 0..width as usize {
            output[y * width as usize + x] = gaussian_from_hash(seed, node_hash, origin_x.wrapping_add(x as i32), origin_y.wrapping_add(y as i32), scale, channel);
        }
    }
    0
}

fn accumulate_field_values(
    accum: &mut [f32],
    field: &[f32],
    width: usize,
    height: usize,
    field_width: usize,
    field_height: usize,
    pad: usize,
    scale: usize,
    channel: usize,
    coefficient: f32,
) -> i32 {
    if width == 0 || height == 0 || field_width == 0 || field_height == 0
        || scale == 0 || channel > 3 || !coefficient.is_finite()
        || accum.len() < width * height * 3 || field.len() < field_width * field_height
    { return -1; }
    let w = width as usize;
    let h = height as usize;
    let fw = field_width as usize;
    let fh = field_height as usize;
    let n = w * h;
    let inverse = 1.0_f32 / scale as f32;
    if scale == 1 {
        if pad + h > fh || pad + w > fw { return -1; }
        for y in 0..h {
            for x in 0..w {
                let value = field[(y + pad) * fw + x + pad] * coefficient;
                let index = y * w + x;
                if channel == 3 {
                    accum[index] += value;
                    accum[n + index] += value;
                    accum[2 * n + index] += value;
                } else {
                    accum[channel as usize * n + index] += value;
                }
            }
        }
        return 0;
    }
    let pad = pad as f32;
    for y in 0..h {
        let fy = ((y as f32 + 0.5) * inverse - 0.5 + pad).clamp(0.0, (fh - 1) as f32);
        let y0 = fy.floor() as usize;
        let y1 = (y0 + 1).min(fh - 1);
        let ty = fy - y0 as f32;
        for x in 0..w {
            let fx = ((x as f32 + 0.5) * inverse - 0.5 + pad).clamp(0.0, (fw - 1) as f32);
            let x0 = fx.floor() as usize;
            let x1 = (x0 + 1).min(fw - 1);
            let tx = fx - x0 as f32;
            let top_left = field[y0 * fw + x0];
            let top_right = field[y0 * fw + x1];
            let bottom_left = field[y1 * fw + x0];
            let bottom_right = field[y1 * fw + x1];
            let top = top_left + (top_right - top_left) * tx;
            let bottom = bottom_left + (bottom_right - bottom_left) * tx;
            let value = (top + (bottom - top) * ty) * coefficient;
            let index = y * w + x;
            if channel == 3 {
                accum[index] += value;
                accum[n + index] += value;
                accum[2 * n + index] += value;
            } else {
                accum[channel as usize * n + index] += value;
            }
        }
    }
    0
}

fn accumulate_grain_fields_values(
    accum: &mut [f32],
    fields: &[f32],
    width: usize,
    height: usize,
    field_width: usize,
    field_height: usize,
    pad: usize,
    scale: usize,
    shared_coefficient: f32,
    independent_coefficient: f32,
) -> i32 {
    let n = width * height;
    let field_pixels = field_width * field_height;
    if width == 0 || height == 0 || field_width == 0 || field_height == 0 || scale == 0
        || accum.len() < n * 3 || fields.len() < field_pixels * 4
        || !shared_coefficient.is_finite() || !independent_coefficient.is_finite()
    { return ERR_INTERNAL; }
    let sample = |plane: usize, x: usize, y: usize| fields[plane * field_pixels + y * field_width + x];
    if scale == 1 {
        if pad + height > field_height || pad + width > field_width { return ERR_INTERNAL; }
        for y in 0..height {
            for x in 0..width {
                let field_index = (y + pad) * field_width + x + pad;
                let shared = fields[field_index] * shared_coefficient;
                let index = y * width + x;
                accum[index] += shared;
                accum[n + index] += shared;
                accum[n * 2 + index] += shared;
                accum[index] += fields[field_pixels + field_index] * independent_coefficient;
                accum[n + index] += fields[field_pixels * 2 + field_index] * independent_coefficient;
                accum[n * 2 + index] += fields[field_pixels * 3 + field_index] * independent_coefficient;
            }
        }
        return 0;
    }
    let inverse = 1.0_f32 / scale as f32;
    let pad_f32 = pad as f32;
    for y in 0..height {
        let fy = ((y as f32 + 0.5) * inverse - 0.5 + pad_f32).clamp(0.0, (field_height - 1) as f32);
        let y0 = fy.floor() as usize;
        let y1 = (y0 + 1).min(field_height - 1);
        let ty = fy - y0 as f32;
        for x in 0..width {
            let fx = ((x as f32 + 0.5) * inverse - 0.5 + pad_f32).clamp(0.0, (field_width - 1) as f32);
            let x0 = fx.floor() as usize;
            let x1 = (x0 + 1).min(field_width - 1);
            let tx = fx - x0 as f32;
            let mut values = [0.0_f32; 4];
            for plane in 0..4 {
                let top = sample(plane, x0, y0) + (sample(plane, x1, y0) - sample(plane, x0, y0)) * tx;
                let bottom = sample(plane, x0, y1) + (sample(plane, x1, y1) - sample(plane, x0, y1)) * tx;
                values[plane] = top + (bottom - top) * ty;
            }
            let shared = values[0] * shared_coefficient;
            let index = y * width + x;
            accum[index] += shared;
            accum[n + index] += shared;
            accum[n * 2 + index] += shared;
            accum[index] += values[1] * independent_coefficient;
            accum[n + index] += values[2] * independent_coefficient;
            accum[n * 2 + index] += values[3] * independent_coefficient;
        }
    }
    0
}

/// Accumulate a generated Grain field directly into three planar destination
/// channels. `channel == 3` adds the same field to R/G/B; 0/1/2 adds only one
/// channel. `field` includes a coordinate-addressed pad around the target.
/// When scale > 1 the exact bilinear sampling used by the JavaScript fallback
/// is performed in the field domain.
#[no_mangle]
pub unsafe extern "C" fn film_accumulate_field_f32(
    accumulator: *mut f32,
    field: *const f32,
    width: u32,
    height: u32,
    field_width: u32,
    field_height: u32,
    pad: u32,
    scale: u32,
    channel: u32,
    coefficient: f32,
) -> i32 {
    if accumulator.is_null() || field.is_null() { return -1; }
    let n = width as usize * height as usize;
    let field_pixels = field_width as usize * field_height as usize;
    accumulate_field_values(
        slice::from_raw_parts_mut(accumulator, n * 3),
        slice::from_raw_parts(field, field_pixels),
        width as usize,
        height as usize,
        field_width as usize,
        field_height as usize,
        pad as usize,
        scale as usize,
        channel as usize,
        coefficient,
    )
}

/// V1.6 fused Grain path for a statistically downsampled field.  The hash
/// coordinate scale is a float because preview/large-document fields are
/// sampled at 1/2 or 1/4 resolution; each coordinate is floored exactly like
/// the JavaScript generator before the blur and bilinear accumulation.
#[no_mangle]
pub unsafe extern "C" fn film_hash_blur_accumulate_f32(
    accumulator: *mut f32,
    workspace: *mut f32,
    width: u32,
    height: u32,
    field_width: u32,
    field_height: u32,
    pad: u32,
    field_preview_scale: f32,
    spatial_scale: u32,
    target_channel: u32,
    coefficient: f32,
    seed: u32,
    node_hash: u32,
    origin_x: f32,
    origin_y: f32,
    scale_index: u32,
    channel_index: u32,
    sigma: f32,
    mode: u32,
) -> i32 {
    if accumulator.is_null()
        || workspace.is_null()
        || !field_preview_scale.is_finite()
        || field_preview_scale <= 0.0
        || !origin_x.is_finite()
        || !origin_y.is_finite()
        || !sigma.is_finite()
        || target_channel > 3
        || spatial_scale == 0
    {
        return -1;
    }
    let fw = field_width as usize;
    let fh = field_height as usize;
    let field_pixels = fw * fh;
    {
        let field = slice::from_raw_parts_mut(workspace, field_pixels * 4);
        let output = &mut field[..field_pixels];
        for y in 0..fh {
            for x in 0..fw {
                let absolute_x = (origin_x + x as f32 / field_preview_scale).floor() as i32;
                let absolute_y = (origin_y + y as f32 / field_preview_scale).floor() as i32;
                output[y * fw + x] = gaussian_from_hash(seed, node_hash, absolute_x, absolute_y, scale_index, channel_index);
            }
        }
    }
    let offset = if sigma >= 0.15 {
        let code = if mode == 0 {
            film_box_blur3(workspace, (field_pixels) as u32, field_width, field_height, sigma)
        } else {
            film_gaussian_blur_f32(workspace, field_pixels as u32, field_width, field_height, sigma)
        };
        if code != 0 { return code; }
        field_pixels
    } else { 0 };
    film_accumulate_field_f32(
        accumulator,
        workspace.add(offset),
        width,
        height,
        field_width,
        field_height,
        pad,
        spatial_scale,
        target_channel,
        coefficient,
    )
}

/// Generate the shared and three independent Grain fields for one physical
/// scale in a single coordinate pass. The four channels reuse the exact hash
/// prefix, then run the unchanged Fast/Quality correlation kernel one at a
/// time and accumulate directly into the resident planar Grain buffer.
/// Workspace layout is four raw fields plus three reusable blur planes.
#[no_mangle]
pub unsafe extern "C" fn film_grain_scale_accumulate_f32(
    accumulator: *mut f32,
    workspace: *mut f32,
    width: u32,
    height: u32,
    field_width: u32,
    field_height: u32,
    pad: u32,
    field_preview_scale: f32,
    spatial_scale: u32,
    shared_coefficient: f32,
    independent_coefficient: f32,
    seed: u32,
    node_hash: u32,
    origin_x: f32,
    origin_y: f32,
    scale_index: u32,
    sigma: f32,
    mode: u32,
) -> i32 {
    if accumulator.is_null() || workspace.is_null()
        || width == 0 || height == 0 || field_width == 0 || field_height == 0
        || spatial_scale == 0 || mode > 1
        || !field_preview_scale.is_finite() || field_preview_scale <= 0.0
        || !origin_x.is_finite() || !origin_y.is_finite() || !sigma.is_finite() || sigma < 0.0
        || !shared_coefficient.is_finite() || !independent_coefficient.is_finite()
    { return -1; }
    let w = width as usize;
    let h = height as usize;
    let fw = field_width as usize;
    let fh = field_height as usize;
    let field_pixels = match fw.checked_mul(fh) { Some(value) => value, None => return -1 };
    let workspace_values = match field_pixels.checked_mul(7) { Some(value) => value, None => return -1 };
    let all = slice::from_raw_parts_mut(workspace, workspace_values);
    let (raw_fields, scratch) = all.split_at_mut(field_pixels * 4);
    let (destination, scratch) = scratch.split_at_mut(field_pixels);
    let (temp_a, temp_b) = scratch.split_at_mut(field_pixels);
    for y in 0..fh {
        for x in 0..fw {
            let absolute_x = (origin_x + x as f32 / field_preview_scale).floor() as i32;
            let absolute_y = (origin_y + y as f32 / field_preview_scale).floor() as i32;
            let prefix = hash_coordinate_prefix(seed, node_hash, absolute_x, absolute_y, scale_index);
            let index = y * fw + x;
            for channel in 0..4 {
                raw_fields[channel * field_pixels + index] = gaussian_from_channel_prefix(prefix, channel as u32);
            }
        }
    }
    let accum = slice::from_raw_parts_mut(accumulator, w * h * 3);
    for channel in 0..4 {
        let source = &raw_fields[channel * field_pixels..(channel + 1) * field_pixels];
        let target_channel = if channel == 0 { 3 } else { channel - 1 };
        let coefficient = if channel == 0 { shared_coefficient } else { independent_coefficient };
        let status = if sigma < 0.15 {
            accumulate_field_values(accum, source, w, h, fw, fh, pad as usize, spatial_scale as usize, target_channel, coefficient)
        } else {
            if mode == 0 {
                let radius = radius_for_sigma(sigma);
                box_once(source, temp_a, destination, fw, fh, radius);
                box_once(destination, temp_a, temp_b, fw, fh, radius);
                box_once(temp_b, temp_a, destination, fw, fh, radius);
            } else {
                gaussian_once(source, temp_a, destination, fw, fh, sigma);
            }
            accumulate_field_values(accum, destination, w, h, fw, fh, pad as usize, spatial_scale as usize, target_channel, coefficient)
        };
        if status != 0 { return status; }
    }
    0
}

/// Apply a precomputed three-channel multiplicative grain field. `rgb` points to
/// 3*pixels values and `noise` to 3*pixels zero-mean unit-variance values.
#[no_mangle]
pub unsafe extern "C" fn film_apply_grain_f32(rgb: *mut f32, noise: *const f32, alpha: *const f32, pixels: u32, amount: f32, iso: f32, profile: u32) -> i32 {
    if rgb.is_null() || noise.is_null() || pixels == 0 || !amount.is_finite() || !iso.is_finite() || iso <= 0.0 { return -1; }
    let rgb_slice = slice::from_raw_parts_mut(rgb, pixels as usize * 3);
    let noise_slice = slice::from_raw_parts(noise, pixels as usize * 3);
    let alpha_slice = if alpha.is_null() { None } else { Some(slice::from_raw_parts(alpha, pixels as usize)) };
    for i in 0..pixels as usize {
        let luminance = (0.2126 * rgb_slice[i * 3] + 0.7152 * rgb_slice[i * 3 + 1] + 0.0722 * rgb_slice[i * 3 + 2]).max(1e-6);
        let x = (luminance / 0.18).log2();
        let envelope = if profile == 1 { 0.35 + 0.75 * (-0.5 * ((x - 0.3) / 1.4).powi(2)).exp() } else { 0.42 + 0.58 * (-0.5 * ((x + 0.5) / 2.0).powi(2)).exp() };
        let sigma_d = 0.085 * amount * (iso / 250.0).sqrt() * envelope;
        let variance = (std::f32::consts::LN_2 * sigma_d).powi(2);
        let mix = alpha_slice.map(|values| values[i]).unwrap_or(1.0);
        for channel in 0..3 {
            let log_gain = (std::f32::consts::LN_2 * sigma_d * noise_slice[i * 3 + channel] - 0.5 * variance).clamp(-20.0, 20.0);
            let gain = log_gain.exp();
            let original = rgb_slice[i * 3 + channel];
            rgb_slice[i * 3 + channel] = original + mix * (original * gain - original);
        }
    }
    0
}

/// Apply Grain directly from the resident planar accumulator. This is the
/// same density model and operation order as `film_apply_grain_f32`; only the
/// noise layout differs, avoiding a planar download and interleaved re-upload.
#[no_mangle]
pub unsafe extern "C" fn film_apply_grain_planar_f32(rgb: *mut f32, noise: *const f32, alpha: *const f32, pixels: u32, amount: f32, iso: f32, profile: u32) -> i32 {
    if rgb.is_null() || noise.is_null() || pixels == 0 || !amount.is_finite() || !iso.is_finite() || iso <= 0.0 { return -1; }
    let n = pixels as usize;
    let rgb_slice = slice::from_raw_parts_mut(rgb, n * 3);
    let noise_slice = slice::from_raw_parts(noise, n * 3);
    let alpha_slice = if alpha.is_null() { None } else { Some(slice::from_raw_parts(alpha, n)) };
    for i in 0..n {
        let luminance = (0.2126 * rgb_slice[i * 3] + 0.7152 * rgb_slice[i * 3 + 1] + 0.0722 * rgb_slice[i * 3 + 2]).max(1e-6);
        let x = (luminance / 0.18).log2();
        let envelope = if profile == 1 { 0.35 + 0.75 * (-0.5 * ((x - 0.3) / 1.4).powi(2)).exp() } else { 0.42 + 0.58 * (-0.5 * ((x + 0.5) / 2.0).powi(2)).exp() };
        let sigma_d = 0.085 * amount * (iso / 250.0).sqrt() * envelope;
        let variance = (std::f32::consts::LN_2 * sigma_d).powi(2);
        let mix = alpha_slice.map(|values| values[i]).unwrap_or(1.0);
        for channel in 0..3 {
            let log_gain = (std::f32::consts::LN_2 * sigma_d * noise_slice[channel * n + i] - 0.5 * variance).clamp(-20.0, 20.0);
            let gain = log_gain.exp();
            let original = rgb_slice[i * 3 + channel];
            rgb_slice[i * 3 + channel] = original + mix * (original * gain - original);
        }
    }
    0
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

fn max_filter_square_values(
    source: &[f32],
    destination: &mut [f32],
    temp: &mut [f32],
    w: usize,
    h: usize,
    r: usize,
) {
    if r == 0 {
        destination.copy_from_slice(source);
        return;
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
}

fn max_filter_square_values_reuse(
    source: &[f32],
    destination: &mut [f32],
    temp: &mut [f32],
    w: usize,
    h: usize,
    r: usize,
    deque: &mut [usize],
) -> i32 {
    if source.len() < w * h || destination.len() < w * h || temp.len() < w * h
        || deque.len() < w.max(h)
    {
        return ERR_CAPACITY;
    }
    if r == 0 {
        destination[..w * h].copy_from_slice(&source[..w * h]);
        return 0;
    }
    for y in 0..h {
        let row = y * w;
        let mut head = 0_usize;
        let mut tail = 0_usize;
        let mut next = 0_usize;
        for x in 0..w {
            let right = (x + r).min(w - 1);
            while next <= right {
                let value = source[row + next];
                while tail > head && source[row + deque[tail - 1]] <= value { tail -= 1; }
                deque[tail] = next;
                tail += 1;
                next += 1;
            }
            let left = x.saturating_sub(r);
            while tail > head && deque[head] < left { head += 1; }
            temp[row + x] = source[row + deque[head]];
        }
    }
    for x in 0..w {
        let mut head = 0_usize;
        let mut tail = 0_usize;
        let mut next = 0_usize;
        for y in 0..h {
            let bottom = (y + r).min(h - 1);
            while next <= bottom {
                let value = temp[next * w + x];
                while tail > head && temp[deque[tail - 1] * w + x] <= value { tail -= 1; }
                deque[tail] = next;
                tail += 1;
                next += 1;
            }
            let top = y.saturating_sub(r);
            while tail > head && deque[head] < top { head += 1; }
            destination[y * w + x] = temp[deque[head] * w + x];
        }
    }
    0
}

// The compact Halation extraction prototype was numerically correct but
// required a ten-plane staging allocation and regressed 24MP throughput. Keep
// the prototype source for future true-resident integration, but compile it
// out of the shipping scalar module so it cannot enlarge the package or be
// mistaken for an executable resident capability.
mod resident_halation_extract {
use super::*;

const HALATION_RESPONSE_LIMIT: f64 = 8.0;
const HALATION_CLASS_SOFTNESS: f64 = 0.25;
const HALATION_HUE_PURITY_START: f64 = 0.35;
const HALATION_HUE_PURITY_FULL: f64 = 0.80;
const HALATION_RED_RESPONSE: [f64; 6] = [1.45, 1.15, 0.62, 0.015, 0.002, 0.82];
const HALATION_GREEN_RESPONSE: [f64; 6] = [0.35, 1.25, 0.85, 0.008, 0.001, 0.12];
const HALATION_BLUE_RESPONSE: [f64; 6] = [0.10, 0.08, 0.04, 0.002, 0.0, 0.04];

#[inline]
fn smoothstep_f64(edge0: f64, edge1: f64, x: f64) -> f64 {
    if edge0 == edge1 { return if x >= edge1 { 1.0 } else { 0.0 }; }
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline]
fn reconstructed_source_exposure(radiance: f64, threshold: f64) -> f64 {
    let e = if radiance.is_finite() { radiance.max(0.0) } else { 0.0 };
    let t = if threshold.is_finite() { threshold.max(0.0) } else { 0.0 };
    if e <= t { return 0.0; }
    if t < 1.0 {
        if e <= 1.0 { (e - t) / (1.0 - t).max(1e-6) } else { 1.0 + resident_fast_log2_f64(e) }
    } else {
        resident_fast_log2_f64(e / t.max(1e-6)).max(0.0)
    }
}

#[inline]
fn compressed_highlight_response(radiance: f64, threshold: f64, impact: f64) -> f64 {
    let normalized = reconstructed_source_exposure(radiance, threshold);
    if normalized <= 0.0 { return 0.0; }
    let exponent = 1.0 + 1.5 * impact.clamp(0.0, 1.0);
    let raw = resident_fast_exp_f64(exponent * resident_fast_log2_f64(normalized.max(f64::MIN_POSITIVE)) * std::f64::consts::LN_2);
    HALATION_RESPONSE_LIMIT * raw / (HALATION_RESPONSE_LIMIT - 1.0 + raw)
}

#[inline]
pub(super) fn spectral_hue_response(r: f64, g: f64, b: f64) -> (f64, f64, f64, f64) {
    let pr = if r.is_finite() { r.max(0.0) } else { 0.0 };
    let pg = if g.is_finite() { g.max(0.0) } else { 0.0 };
    let pb = if b.is_finite() { b.max(0.0) } else { 0.0 };
    let max_value = pr.max(pg).max(pb);
    let min_value = pr.min(pg).min(pb);
    let delta = max_value - min_value;
    if max_value <= 1e-12 || delta <= 1e-12 { return (0.0, 1.0, 1.0, 1.0); }
    let h6 = if max_value == pr {
        ((pg - pb) / delta + 6.0) % 6.0
    } else if max_value == pg {
        (pb - pr) / delta + 2.0
    } else {
        (pr - pg) / delta + 4.0
    };
    let floor_h6 = h6.floor();
    let i0 = floor_h6 as usize % 6;
    let i1 = (i0 + 1) % 6;
    let raw_t = h6 - floor_h6;
    let t = raw_t * raw_t * (3.0 - 2.0 * raw_t);
    let lerp = |a: f64, c: f64| a + (c - a) * t;
    (
        delta / max_value,
        lerp(HALATION_RED_RESPONSE[i0], HALATION_RED_RESPONSE[i1]),
        lerp(HALATION_GREEN_RESPONSE[i0], HALATION_GREEN_RESPONSE[i1]),
        lerp(HALATION_BLUE_RESPONSE[i0], HALATION_BLUE_RESPONSE[i1]),
    )
}

/// Fused compact Halation extraction. The eight output planes are Y, local
/// gate, W, U, K, source R, source G and source B. Source Expansion performs
/// its two semantic passes and square max propagation without returning to JS.
///
/// # Safety
/// RGB contains `3*pixels`, optional alpha contains `pixels`, output contains
/// `8*pixels`, and scratch contains `2*pixels` non-overlapping values.
pub(super) unsafe fn extract_compact(
    rgb: *const f32,
    alpha: *const f32,
    output: *mut f32,
    scratch: *mut f32,
    pixels: u32,
    width: u32,
    height: u32,
    luma_r: f64,
    luma_g: f64,
    luma_b: f64,
    threshold: f64,
    source_softness: f64,
    background_threshold: f64,
    background_softness: f64,
    spill_mix: f64,
    source_impact: f64,
    hot_threshold: f64,
    spectral_sensitivity: f64,
    blue_compensation: f64,
    red_layer_threshold_bias: f64,
    source_expansion: f64,
    source_interior_protection: f64,
    sigma: f64,
    amplify: f64,
    deque: &mut [usize],
) -> i32 {
    if rgb.is_null() || output.is_null() || scratch.is_null() || width == 0 || height == 0
        || width.checked_mul(height) != Some(pixels)
    {
        return -1;
    }
    let params = [
        luma_r, luma_g, luma_b, threshold, source_softness,
        background_threshold, background_softness, spill_mix, source_impact,
        hot_threshold, spectral_sensitivity, blue_compensation,
        red_layer_threshold_bias, source_expansion, source_interior_protection,
        sigma, amplify,
    ];
    if params.iter().any(|value| !value.is_finite()) { return -2; }
    let n = pixels as usize;
    let rgb_values = slice::from_raw_parts(rgb, n * 3);
    if rgb_values.iter().any(|value| !value.is_finite()) { return -3; }
    let alpha_values = if alpha.is_null() { None } else {
        let values = slice::from_raw_parts(alpha, n);
        if values.iter().any(|value| !value.is_finite()) { return -3; }
        Some(values)
    };
    let all_output = slice::from_raw_parts_mut(output, n * 8);
    let (luminance, rest) = all_output.split_at_mut(n);
    let (local_gate, rest) = rest.split_at_mut(n);
    let (source_weight, rest) = rest.split_at_mut(n);
    let (source_exposure, rest) = rest.split_at_mut(n);
    let (source_authorization, rest) = rest.split_at_mut(n);
    let (source_r, rest) = rest.split_at_mut(n);
    let (source_g, source_b) = rest.split_at_mut(n);
    source_authorization.fill(0.0);
    let all_scratch = slice::from_raw_parts_mut(scratch, n * 2);
    let (expanded_support, max_temp) = all_scratch.split_at_mut(n);

    let t0 = threshold - source_softness * 0.5;
    let t1 = threshold + source_softness * 0.5;
    let g0 = background_threshold - background_softness;
    let g1 = background_threshold;
    let spectral_mix_base = smoothstep_f64(0.0, 1.0, spectral_sensitivity.clamp(0.0, 1.0));
    let bias = red_layer_threshold_bias.clamp(0.0, 1.0);
    let spill = spill_mix.clamp(0.0, 1.0);
    let blue_comp = blue_compensation.clamp(0.0, 1.0);

    for i in 0..n {
        let p = i * 3;
        let r = rgb_values[p] as f64;
        let g = rgb_values[p + 1] as f64;
        let b = rgb_values[p + 2] as f64;
        let a = alpha_values.map(|values| values[i] as f64).unwrap_or(1.0).clamp(0.0, 1.0);
        let y = luma_r * r + luma_g * g + luma_b * b;
        let m = r.max(g).max(b);
        luminance[i] = y as f32;
        let threshold_mask = smoothstep_f64(t0, t1, y);
        let spill_mask = smoothstep_f64(t0, t1, m);
        let legacy_mask = if spill == 0.0 { threshold_mask } else { threshold_mask * (1.0 - spill) + spill_mask * spill };
        let legacy_radiance = (y * (1.0 - spill) + m * spill).max(0.0);
        let red_layer_exposure = (0.82 * r + 0.16 * g + 0.02 * b).max(0.0);
        let pr = r.max(0.0);
        let pg = g.max(0.0);
        let pb = b.max(0.0);
        let mut red_hue_gain = 1.0;
        let mut green_hue_gain = 1.0;
        let mut blue_hue_gain = 1.0;
        let mut red_emitter_confidence = 1.0;
        if spectral_sensitivity > 0.0 {
            let (saturation, hue_red, hue_green, hue_blue) = spectral_hue_response(pr, pg, pb);
            let purity_gate = smoothstep_f64(HALATION_HUE_PURITY_START, HALATION_HUE_PURITY_FULL, saturation);
            let hue_mix = spectral_mix_base * purity_gate;
            red_hue_gain += hue_mix * (hue_red - 1.0);
            green_hue_gain += hue_mix * (hue_green - 1.0);
            blue_hue_gain += hue_mix * (hue_blue - 1.0);
            red_emitter_confidence += hue_mix * (hue_red.clamp(0.0, 1.0) - 1.0);
        }
        let red_layer_mask = smoothstep_f64(t0, t1, red_layer_exposure);
        let legacy_masked_source = legacy_mask * a;
        let red_layer_masked_source = red_layer_mask * red_emitter_confidence * a;
        let legacy_response = compressed_highlight_response(legacy_radiance, threshold, source_impact);
        let red_layer_response = compressed_highlight_response(red_layer_exposure, threshold, source_impact);
        let legacy_amplitude = legacy_masked_source * legacy_response;
        let red_layer_amplitude = red_layer_masked_source * red_layer_response;
        let amplitude = legacy_amplitude + (red_layer_amplitude - legacy_amplitude) * bias;

        let long_wave = 0.82 * r + 0.18 * g;
        let clamped_long_wave = long_wave.clamp(0.0, 1.0);
        let base_gate = 1.0 - smoothstep_f64(g0, g1, clamped_long_wave);
        let background_peak = pr.max(pg).max(pb);
        let cool_background = if background_peak > 1e-8 { (pb - pr).max(0.0) / background_peak } else { 0.0 };
        local_gate[i] = (base_gate + (1.0 - base_gate) * cool_background * blue_comp) as f32;

        let legacy_exposure = reconstructed_source_exposure(legacy_radiance, threshold);
        let red_exposure_coordinate = reconstructed_source_exposure(red_layer_exposure, threshold) * red_emitter_confidence;
        let exposure = legacy_exposure + (red_exposure_coordinate - legacy_exposure) * bias;
        source_exposure[i] = exposure as f32;
        source_weight[i] = amplitude as f32;

        let legacy_norm = if legacy_radiance > 1e-8 { legacy_amplitude / legacy_radiance } else { 0.0 };
        let red_norm = if red_layer_exposure > 1e-8 { red_layer_amplitude / red_layer_exposure } else { 0.0 };
        let legacy_hot = smoothstep_f64(hot_threshold - HALATION_CLASS_SOFTNESS, hot_threshold + HALATION_CLASS_SOFTNESS, legacy_exposure);
        let red_hot = smoothstep_f64(hot_threshold - HALATION_CLASS_SOFTNESS, hot_threshold + HALATION_CLASS_SOFTNESS, red_exposure_coordinate);
        let legacy_green_shoulder = 0.12 + 0.88 * legacy_hot;
        let red_green_shoulder = 0.12 + 0.88 * red_hot;
        let red_incident = (0.82 * pr + 0.16 * pg + 0.02 * pb).max(0.0);
        let green_incident = (0.08 * pr + 0.74 * pg + 0.03 * pb).max(0.0);
        let blue_incident = (0.01 * pr + 0.03 * pg + 0.06 * pb).max(0.0);
        let legacy_r = red_incident * legacy_norm * red_hue_gain;
        let layer_r = red_incident * red_norm * red_hue_gain;
        let legacy_g = green_incident * legacy_norm * legacy_green_shoulder * green_hue_gain;
        let layer_g = green_incident * red_norm * red_green_shoulder * green_hue_gain;
        let legacy_b = blue_incident * legacy_norm * blue_hue_gain;
        let layer_b = blue_incident * red_norm * blue_hue_gain;
        source_r[i] = (legacy_r + (layer_r - legacy_r) * bias) as f32;
        source_g[i] = (legacy_g + (layer_g - legacy_g) * bias) as f32;
        source_b[i] = (legacy_b + (layer_b - legacy_b) * bias) as f32;
    }

    let expansion = source_expansion.clamp(0.0, 1.0);
    if expansion > 0.0 {
        for i in 0..n {
            let hot_mix = smoothstep_f64(
                hot_threshold - HALATION_CLASS_SOFTNESS,
                hot_threshold + HALATION_CLASS_SOFTNESS,
                source_exposure[i] as f64,
            );
            // Preserve source_weight: it already contains the first-pass
            // canonical amplitude.  The expansion pass used to overwrite it
            // with this max-filter seed and then recompute both compressed
            // highlight responses for every pixel.  source_authorization is
            // dead until after the max filter, so it is the safe liveness
            // alias for the seed plane.
            source_authorization[i] = ((source_r[i] as f64 * hot_mix).clamp(0.0, 1.0)) as f32;
        }
        let grow_radius = (sigma.max(0.5) * (0.45 + 0.85 * expansion)).ceil().max(1.0) as usize;
        let filter_code = max_filter_square_values_reuse(
            source_authorization,
            expanded_support,
            max_temp,
            width as usize,
            height as usize,
            grow_radius,
            deque,
        );
        if filter_code != 0 { return filter_code; }
        let lower_threshold = (threshold * (1.0 - 0.68 * expansion)).max(0.0);
        let candidate_softness = (source_softness * 2.0).max(0.02);
        let candidate_end = (lower_threshold + candidate_softness).max(threshold);
        let keep_authorization = source_interior_protection > 0.0;
        for i in 0..n {
            let p = i * 3;
            let r = rgb_values[p] as f64;
            let g = rgb_values[p + 1] as f64;
            let b = rgb_values[p + 2] as f64;
            let a = alpha_values.map(|values| values[i] as f64).unwrap_or(1.0).clamp(0.0, 1.0);
            let y = luma_r * r + luma_g * g + luma_b * b;
            let m = r.max(g).max(b);
            let legacy_radiance = (y * (1.0 - spill) + m * spill).max(0.0);
            let red_layer_exposure = (0.82 * r + 0.16 * g + 0.02 * b).max(0.0);
            let mut red_emitter_confidence = 1.0;
            if spectral_sensitivity > 0.0 {
                let (saturation, hue_red, _, _) = spectral_hue_response(r.max(0.0), g.max(0.0), b.max(0.0));
                let purity_gate = smoothstep_f64(HALATION_HUE_PURITY_START, HALATION_HUE_PURITY_FULL, saturation);
                let hue_mix = spectral_mix_base * purity_gate;
                red_emitter_confidence += hue_mix * (hue_red.clamp(0.0, 1.0) - 1.0);
            }
            let base_amplitude = source_weight[i] as f64;
            let legacy_candidate = smoothstep_f64(lower_threshold, candidate_end, legacy_radiance) * a;
            let red_candidate = smoothstep_f64(lower_threshold, candidate_end, red_layer_exposure) * red_emitter_confidence * a;
            let candidate = legacy_candidate + (red_candidate - legacy_candidate) * bias;
            let support = expanded_support[i] as f64;
            let eligibility = if keep_authorization { red_emitter_confidence } else { 1.0 };
            let authorized = candidate * support * eligibility;
            let grown = authorized * expansion * 0.42;
            source_weight[i] = base_amplitude.max(grown) as f32;
            if keep_authorization { source_authorization[i] = authorized as f32; }
            source_r[i] = (source_r[i] as f64).max(grown) as f32;
            source_g[i] = (source_g[i] as f64).max(grown * (0.12 + 0.12 * support)) as f32;
        }
    }

    let final_amplify = amplify.clamp(0.0, 4.0);
    if final_amplify != 1.0 {
        let green_amplify = if final_amplify <= 1.0 { final_amplify } else { 1.0 + (final_amplify - 1.0) * 0.55 };
        let blue_amplify = if final_amplify <= 1.0 { final_amplify } else { 1.0 + (final_amplify - 1.0) * 0.15 };
        for i in 0..n {
            source_r[i] = (source_r[i] as f64 * final_amplify) as f32;
            source_g[i] = (source_g[i] as f64 * green_amplify) as f32;
            source_b[i] = (source_b[i] as f64 * blue_amplify) as f32;
            source_weight[i] = (source_weight[i] as f64 * final_amplify) as f32;
        }
    }
    0
}

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
    let all = slice::from_raw_parts_mut(pointer, n * 3);
    let (source, rest) = all.split_at_mut(n);
    let (destination, temp) = rest.split_at_mut(n);
    max_filter_square_values(source, destination, temp, width as usize, height as usize, radius as usize);
    0
}
