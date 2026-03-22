const cloudinary  = require('cloudinary').v2;
const multer      = require('multer');
const streamifier = require('streamifier');
const path        = require('path');
const fs          = require('fs');

// Auto-configured from CLOUDINARY_URL env var
// Format: cloudinary://API_KEY:API_SECRET@CLOUD_NAME
if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
}

const useCloudinary = !!process.env.CLOUDINARY_URL;

// Always use memory storage — we'll pipe to Cloudinary or disk ourselves
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.jpg','.jpeg','.png','.webp'].includes(
      path.extname(file.originalname).toLowerCase()
    );
    cb(null, ok);
  }
});

// Upload a single file buffer — returns the public URL
function uploadBuffer(buffer, filename) {
  return new Promise((resolve, reject) => {
    if (useCloudinary) {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'spacelogg/spaces', resource_type: 'image',
          transformation: [{ width: 1200, height: 800, crop: 'limit', quality: 'auto' }] },
        (err, result) => err ? reject(err) : resolve(result.secure_url)
      );
      streamifier.createReadStream(buffer).pipe(stream);
    } else {
      // Save to local disk
      const uploadDir = process.env.UPLOAD_DIR || './public/uploads';
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const ext  = path.extname(filename).toLowerCase() || '.jpg';
      const name = `space_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
      const dest = path.join(uploadDir, name);
      fs.writeFileSync(dest, buffer);
      resolve(`/uploads/${name}`);
    }
  });
}

// Upload all files in req.files array, return array of URLs
async function uploadFiles(files = []) {
  return Promise.all(files.map(f => uploadBuffer(f.buffer, f.originalname)));
}

module.exports = { upload, uploadFiles, useCloudinary };
