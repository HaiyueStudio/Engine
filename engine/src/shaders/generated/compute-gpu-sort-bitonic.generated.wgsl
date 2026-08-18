// haiyue:compute-pass gpu-sort-bitonic
// haiyue:compute-abi 1
// haiyue:compute-ir 5e1bc79bc112c5275bfe3ba617ff10ce6927a108e167aa3883b80cfc15f27368
// haiyue:compute-module 224edd29cb3a5bf01c487e04e033918d52080c080ac656754d0a633b961894a6
// source: shader-language/builtin-compute-family.json

struct SortParams {
  elementCount: u32,
  paddedCount: u32,
  j: u32,
  k: u32,
  keyWords: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<storage, read_write> keys: array<u32>;
@group(0) @binding(1) var<storage, read_write> indices: array<u32>;
@group(0) @binding(2) var<storage, read> params: SortParams;

fn key_word(element: u32, word: u32) -> u32 {
  if (word >= params.keyWords) { return 0u; }
  return keys[element * params.keyWords + word];
}

fn key_greater(a: u32, aIndex: u32, b: u32, bIndex: u32) -> bool {
  for (var word = 0u; word < 8u; word = word + 1u) {
    let aKey = key_word(a, word);
    let bKey = key_word(b, word);
    if (aKey != bKey) { return aKey > bKey; }
  }
  return aIndex > bIndex;
}

fn key_less(a: u32, aIndex: u32, b: u32, bIndex: u32) -> bool {
  for (var word = 0u; word < 8u; word = word + 1u) {
    let aKey = key_word(a, word);
    let bKey = key_word(b, word);
    if (aKey != bKey) { return aKey < bKey; }
  }
  return aIndex < bIndex;
}

fn swap_keys(a: u32, b: u32) {
  for (var word = 0u; word < 8u; word = word + 1u) {
    if (word >= params.keyWords) { return; }
    let aOffset = a * params.keyWords + word;
    let bOffset = b * params.keyWords + word;
    let value = keys[aOffset];
    keys[aOffset] = keys[bOffset];
    keys[bOffset] = value;
  }
}

fn should_swap(a: u32, aIndex: u32, b: u32, bIndex: u32, ascending: bool) -> bool {
  let greater = key_greater(a, aIndex, b, bIndex);
  let less = key_less(a, aIndex, b, bIndex);
  return select(less, greater, ascending);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.paddedCount) { return; }
  let ixj = i ^ params.j;
  if (ixj <= i || ixj >= params.paddedCount) { return; }
  let ascending = (i & params.k) == 0u;
  let aIndex = indices[i];
  let bIndex = indices[ixj];
  if (should_swap(i, aIndex, ixj, bIndex, ascending)) {
    swap_keys(i, ixj);
    indices[i] = bIndex;
    indices[ixj] = aIndex;
  }
}
