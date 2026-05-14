const fs = require('fs');
const path = require('path');

let _cache = null;

function lookup(localName) {
  if (!_cache) {
    const p = path.join(__dirname, '../../data/plant_lookup_v1.json');
    _cache = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  }
  const normalised = localName.toLowerCase().trim();
  return _cache.find(e => e.local_name.toLowerCase() === normalised) ?? null;
}

module.exports = { lookup };
