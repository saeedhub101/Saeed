// Runs when the add-on is built: downloads the language data so OCR works offline.
const fs = require('fs');
const path = require('path');
const https = require('https');
const get = (url, dest) => new Promise((resolve, reject) => {
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return get(res.headers.location, dest).then(resolve, reject);
    if (res.statusCode !== 200) return reject(new Error(url + ' -> ' + res.statusCode));
    res.pipe(fs.createWriteStream(dest)).on('finish', resolve).on('error', reject);
  }).on('error', reject);
});
module.exports = async function prepare(dir) {
  const out = path.join(dir, 'tessdata');
  fs.mkdirSync(out, { recursive: true });
  for (const l of ['eng', 'ara']) await get(`https://github.com/tesseract-ocr/tessdata_fast/raw/main/${l}.traineddata`, path.join(out, `${l}.traineddata`));
};
