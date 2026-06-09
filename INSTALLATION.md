# Installation Guide for Video Support

This extension now supports both **images** and **videos**. For videos, it extracts the first frame and generates a thumbhash from it.

## Prerequisites

1. **ffmpeg** must be installed in your Directus Docker container (required for video processing)
2. Node.js dependencies will be installed automatically via the docker-compose entrypoint

## Installation Steps

### Step 1: Build the Extension

Build the extension from the source code:

```bash
cd /Users/hardikverma/docker/content-dev/extensions/directus-extension-thumbhash
pnpm install
pnpm build
```

Or if you prefer npm:
```bash
cd /Users/hardikverma/docker/content-dev/extensions/directus-extension-thumbhash
npm install
npm run build
```

### Step 2: Install ffmpeg in Docker Container

Since video processing requires `ffmpeg`, you need to install it in your Directus container.

#### Option A: Install in Running Container (Quick)

```bash
# Get your container ID
docker ps

# Install ffmpeg
docker exec <container-id> apt-get update && apt-get install -y ffmpeg
```

#### Option B: Add to docker-compose.yml (Permanent)

Update your `docker-compose.yml` to install ffmpeg on container startup:

```yaml
services:
  directus:
    # ... existing config ...
    entrypoint: >
      sh -c "
      apt-get update && apt-get install -y ffmpeg 2>/dev/null || true &&
      if [ -d /directus/extensions/directus-extension-thumbhash ]; then
        echo 'Installing dependencies for directus-extension-thumbhash...' &&
        cd /directus/extensions/directus-extension-thumbhash &&
        (npm install --include=optional 2>/dev/null || true);
      fi &&
      exec docker-entrypoint.sh
      "
```

### Step 3: Restart the Container

```bash
cd /Users/hardikverma/docker/content-dev
docker-compose restart directus
```

Or if you modified docker-compose.yml:
```bash
docker-compose down
docker-compose up -d
```

### Step 4: Verify Installation

1. **Check logs** to ensure the extension loaded:
   ```bash
   docker logs <container-id> | grep -i thumbhash
   ```

2. **Test with an image upload** - should work as before

3. **Test with a video upload** - should generate thumbhash from first frame

## How It Works

- **Images**: Works exactly as before - generates thumbhash from the image
- **Videos**: 
  1. Downloads the video file
  2. Extracts the first frame using `ffmpeg`
  3. Processes the frame with `sharp` to generate thumbhash
  4. Stores the thumbhash in the same `thumbhash` field

## Troubleshooting

### ffmpeg not found error

If you see errors about ffmpeg not being found:
```bash
docker exec <container-id> which ffmpeg
```

If it returns nothing, install ffmpeg (see Step 2).

### Video processing fails

Check the logs:
```bash
docker logs <container-id> | grep -i "thumbhash\|video"
```

Common issues:
- ffmpeg not installed
- Video file format not supported
- Insufficient disk space for temporary files

### Extension not loading

1. Verify the extension is built:
   ```bash
   ls -la extensions/directus-extension-thumbhash/dist/index.js
   ```

2. Check container logs for errors:
   ```bash
   docker logs <container-id> | tail -50
   ```

3. Ensure dependencies are installed in container:
   ```bash
   docker exec <container-id> ls -la /directus/extensions/directus-extension-thumbhash/node_modules
   ```

## Notes

- Temporary video files are automatically cleaned up after processing
- The extension works with both local storage and S3 (as configured in your docker-compose.yml)
- Video processing may take longer than image processing due to frame extraction
