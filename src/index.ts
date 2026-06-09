import {
  type FilesService,
  type ItemsService,
  type AssetsService,
} from "@directus/api";
import { type HookConfig } from "@directus/types";
import { type File } from "@directus/api/dist/types";
import { defineHook } from "@directus/extensions-sdk";
import { exec } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import { promises as fsp } from "fs";
import { randomUUID } from "crypto";

const execAsync = promisify(exec);

export default defineHook<HookConfig>(async function (
  { init, action },
  { database, services, getSchema }
) {
  const filesService: typeof FilesService = services.FilesService;
  async function getFilesService() {
    return new filesService({
      knex: database,
      schema: await getSchema(),
      accountability: null,
    }) as FilesService & ItemsService<File>;
  }

  const assetsService: typeof AssetsService = services.AssetsService;
  async function getAssetsService() {
    return new assetsService({ knex: database, schema: await getSchema(), accountability: null });
  }

  const itemsService: typeof ItemsService = services.ItemsService;
  async function getItemsService(collection: string) {
    return new itemsService(collection, {
      knex: database,
      schema: await getSchema(),
      accountability: null,
    });
  }

  function resolveId(value: any): string | null {
    if (!value) return null;
    if (typeof value === "object") return value.id ?? null;
    return value;
  }

  async function detectAudioFromFile(fileId: string): Promise<boolean> {
    const assets = await getAssetsService();
    const files = await getFilesService();

    const file = (await files.readOne(fileId, {
      fields: ["id", "type", "filename_disk"],
    })) as File & { filename_disk?: string | null };

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
      const videoAsset = await assets.getAsset(file.id, {
        transformationParams: {},
      });

      const videoChunks: Buffer[] = [];
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
      } catch (error: any) {
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
      try {
        await fsp.unlink(tempPath);
      } catch {
        // ignore
      }
    }
  }

  init("routes.custom.after", async () => {
    console.log("[---audio---] extension initialized");
  });

  action(
    "files.upload",
    async function ({ payload, key }, _ctx) {
      console.log(`[---audio---] upload received — file: ${key}, type: ${payload?.type}`);
      if (payload?.type?.startsWith("video/")) {
        const hasAudio = await detectAudioFromFile(key).catch(() => false);
        console.log(`[---audio---] file ${key}: has_audio=${hasAudio}`);
      }
    }
  );

  action(
    "items.create",
    async function ({ payload, key, collection }, _ctx) {
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
    }
  );

  action(
    "items.update",
    async function ({ payload, keys, collection }, _ctx) {
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
            const junction = await junctionService.readOne(key, { fields: ["reels_id"] }) as any;
            if (junction?.reels_id) {
              await reels.updateOne(junction.reels_id, { has_audio: hasAudio });
              console.log(`[---audio---] reels/${junction.reels_id}: has_audio=${hasAudio}`);
            }
          }
        } catch (error) {
          console.log("[---audio---] reels_files_1.items.update error:", error);
        }
      }
    }
  );
}) as any;
