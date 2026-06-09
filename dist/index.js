"use strict";

const { exec } = require("child_process");
const { promisify } = require("util");
const { tmpdir } = require("os");
const { join } = require("path");
const { promises: fsp } = require("fs");
const { randomUUID } = require("crypto");

const execAsync = promisify(exec);

module.exports = async function ({ init, action }, { database, services, getSchema }) {
  async function getFilesService() {
    return new services.FilesService({ knex: database, schema: await getSchema() });
  }

  async function getAssetsService() {
    return new services.AssetsService({ knex: database, schema: await getSchema() });
  }

  async function getItemsService(collection) {
    return new services.ItemsService(collection, { knex: database, schema: await getSchema() });
  }

  async function detectAudioFromFile(fileId) {
    const assets = await getAssetsService();
    const files = await getFilesService();

    const file = await files.readOne(fileId, { fields: ["id", "type", "filename_disk"] });

    if (!file) {
      console.log("[---audio---] file not found:", fileId);
      return false;
    }

    if (!file.type?.startsWith("video/")) {
      console.log("[---audio---] skipping non-video file:", file.type);
      return false;
    }

    const tempPath = join(tmpdir(), `has-audio-${randomUUID()}.tmp`);

    try {
      const videoAsset = await assets.getAsset(file.id, { transformationParams: {} });

      const videoChunks = [];
      for await (const chunk of videoAsset.stream) {
        videoChunks.push(chunk);
      }
      await fsp.writeFile(tempPath, Buffer.concat(videoChunks));

      let output = "";
      try {
        const result = await execAsync(
          `ffmpeg -i "${tempPath}" -af volumedetect -vn -sn -dn -f null /dev/null`,
          { maxBuffer: 1024 * 1024 * 10 }
        );
        output = result.stdout + result.stderr;
      } catch (error) {
        output = (error.stdout || "") + (error.stderr || "");
      }

      const match = output.match(/max_volume:\s*([-\d.]+)\s*dB/);
      if (match) {
        const maxVolume = parseFloat(match[1]);
        const hasAudio = maxVolume > -80;
        console.log(`[---audio---] file ${fileId}: max_volume=${maxVolume}dB → has_audio=${hasAudio}`);
        return hasAudio;
      }

      console.log("[---audio---] volumedetect output not found for file:", fileId);
      return false;
    } catch (error) {
      console.log("[---audio---] audio detection error for file:", fileId, error);
      return false;
    } finally {
      try { await fsp.unlink(tempPath); } catch { }
    }
  }

  init("routes.custom.after", async () => {
    console.log("[---audio---] extension initialized");
  });

  action("files.upload", async function ({ payload, key }) {
    console.log(`[---audio---] upload received — file: ${key}, type: ${payload?.type}`);
    if (payload?.type?.startsWith("video/")) {
      const hasAudio = await detectAudioFromFile(key).catch(() => false);
      console.log(`[---audio---] file ${key}: has_audio=${hasAudio}`);
    }
  });

  action("items.create", async function ({ payload, key, collection }) {
    if (collection === "hotel_reels" || collection === "hotel_promotions") {
      const fileId = payload?.media;
      if (!fileId) return;
      console.log(`[---audio---] upload received — ${collection}/${key}, media: ${fileId}`);
      try {
        const hasAudio = await detectAudioFromFile(fileId);
        const items = await getItemsService(collection);
        await items.updateOne(key, { has_audio: hasAudio });
        console.log(`[---audio---] ${collection}/${key}: has_audio=${hasAudio}`);
      } catch (error) {
        console.log(`[---audio---] ${collection}.items.create error:`, error);
      }
    }

    if (collection === "reels_files_1") {
      const fileId = payload?.directus_files_id;
      const reelId = payload?.reels_id;
      if (!fileId || !reelId) return;
      console.log(`[---audio---] upload received — reels/${reelId} via junction, file: ${fileId}`);
      try {
        const hasAudio = await detectAudioFromFile(fileId);
        const reels = await getItemsService("reels");
        await reels.updateOne(reelId, { has_audio: hasAudio });
        console.log(`[---audio---] reels/${reelId}: has_audio=${hasAudio}`);
      } catch (error) {
        console.log("[---audio---] reels_files_1.items.create error:", error);
      }
    }
  });

  action("items.update", async function ({ payload, keys, collection }) {
    if (collection === "hotel_reels" || collection === "hotel_promotions") {
      const fileId = payload?.media;
      if (!fileId) return;
      console.log(`[---audio---] upload received — ${collection} keys=[${keys.join(",")}], media: ${fileId}`);
      try {
        const hasAudio = await detectAudioFromFile(fileId);
        const items = await getItemsService(collection);
        for (const key of keys) {
          await items.updateOne(key, { has_audio: hasAudio });
        }
        console.log(`[---audio---] updated ${keys.length} ${collection} record(s): has_audio=${hasAudio}`);
      } catch (error) {
        console.log(`[---audio---] ${collection}.items.update error:`, error);
      }
    }

    if (collection === "reels_files_1") {
      const fileId = payload?.directus_files_id;
      if (!fileId) return;
      console.log(`[---audio---] upload received — reels_files_1 keys=[${keys.join(",")}], file: ${fileId}`);
      try {
        const hasAudio = await detectAudioFromFile(fileId);
        const junctionService = await getItemsService("reels_files_1");
        const reels = await getItemsService("reels");
        for (const key of keys) {
          const junction = await junctionService.readOne(key, { fields: ["reels_id"] });
          if (junction?.reels_id) {
            await reels.updateOne(junction.reels_id, { has_audio: hasAudio });
            console.log(`[---audio---] reels/${junction.reels_id}: has_audio=${hasAudio}`);
          }
        }
      } catch (error) {
        console.log("[---audio---] reels_files_1.items.update error:", error);
      }
    }
  });
};
