'use strict';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIdArray = (v) => Array.isArray(v) && v.every((r) => isObject(r) && typeof r.id === 'string');

// Returns undefined when b removes the value (null, without keepMarkers).
function mergeValue(a, b, opts = {}) {
  const keep = opts.keepMarkers === true;
  if (b === undefined) return a === undefined ? undefined : structuredClone(a);
  if (b === null) return keep ? null : undefined;
  if (isObject(b)) {
    const out = isObject(a) ? structuredClone(a) : {};
    for (const [key, value] of Object.entries(b)) {
      const merged = mergeValue(out[key], value, opts);
      if (merged === undefined) delete out[key];
      else out[key] = merged;
    }
    return out;
  }
  if (isIdArray(b)) {
    const out = isIdArray(a) ? structuredClone(a) : [];
    for (const record of b) {
      const at = out.findIndex((r) => r.id === record.id);
      if (record.off === true && !keep) {
        if (at !== -1) out.splice(at, 1);
        continue;
      }
      const merged = mergeValue(at === -1 ? {} : out[at], record, opts);
      if (at === -1) out.push(merged);
      else out[at] = merged;
    }
    return out;
  }
  return structuredClone(b);
}

// Each layer is a sections object keyed by heading name. Later layers win.
function resolveConfig(layers) {
  const config = {};
  for (const layer of layers) {
    for (const [heading, value] of Object.entries(layer || {})) {
      const key = heading.toLowerCase();
      const merged = mergeValue(config[key], value);
      if (merged === undefined) delete config[key];
      else config[key] = merged;
    }
  }
  return config;
}

function diffConfigs(a, b, prefix = '') {
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => diffConfigs(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  if (isIdArray(a) && isIdArray(b)) {
    const ids = [...new Set([...a.map((r) => r.id), ...b.map((r) => r.id)])];
    return ids.flatMap((id) => diffConfigs(a.find((r) => r.id === id), b.find((r) => r.id === id), `${prefix}[${id}]`));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path: prefix, from: a, to: b }];
}

module.exports = { isObject, isIdArray, mergeValue, resolveConfig, diffConfigs };
