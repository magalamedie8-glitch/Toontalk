/* Downloads the Piper engine files (about 30 MB) into public/vendor/piper so ToonTalk can make voices offline.
   Run once from the Toontalk folder:   node tools/get-piper.js
   Needs internet and npm. The voices themselves are downloaded from inside the app (🗣 Offline voices). */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..');
const tmp = path.join(__dirname, '_piper_tmp');
const out = path.join(root, 'public', 'vendor', 'piper');
fs.mkdirSync(tmp, { recursive: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"piper-tmp","private":true}');
console.log('Downloading engine files from npm...');
const r = cp.spawnSync('npm', ['install', '--no-audit', '--no-fund', 'onnxruntime-web@1.18.0', '@diffusionstudio/piper-wasm@1.0.0'],
  { cwd: tmp, stdio: 'inherit', shell: true });
if (r.status !== 0) { console.error('npm install failed'); process.exit(1); }
const nm = path.join(tmp, 'node_modules');
const files = [
  ['onnxruntime-web/dist/ort.wasm.min.js', 'ort.wasm.min.js'],
  ['onnxruntime-web/dist/ort-wasm-simd.wasm', 'ort-wasm-simd.wasm'],
  ['@diffusionstudio/piper-wasm/build/piper_phonemize.js', 'piper_phonemize.js'],
  ['@diffusionstudio/piper-wasm/build/piper_phonemize.wasm', 'piper_phonemize.wasm'],
  ['@diffusionstudio/piper-wasm/build/piper_phonemize.data', 'piper_phonemize.data']
];
files.forEach(([from, to]) => {
  fs.copyFileSync(path.join(nm, from), path.join(out, to));
  console.log('  copied', to, Math.round(fs.statSync(path.join(out, to)).size / 1048576 * 10) / 10 + ' MB');
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nDone. Engine files are in public/vendor/piper. Now run npm start, open the app and press 🗣 Offline voices.');