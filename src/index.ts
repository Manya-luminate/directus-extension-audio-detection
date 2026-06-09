import {
  type FieldsService,
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
import { writeFile, unlink, readFile } from "fs/promises";
import { randomUUID } from "crypto";

import * as thumbhash from "thumbhash";

const execAsync = promisify(exec);

export default defineHook<HookConfig>(async function (
  { init, action },
  { database, services, getSchema }
) {
  let sharp: any = null;

  try {
    sharp = require("sharp");
  } catch (error) {
    console.log(error);
    process.exit(1);
  }

  const fieldsService: typeof FieldsService = services.FieldsService;
  async function getFieldsService() {
    return new fieldsService({ knex: database, schema: await getSchema() });
  }

  const filesService: typeof FilesService = services.FilesService;
  async function getFilesService() {
    return new filesService({
      knex: database,
      schema: await getSchema(),
    }) as FilesService & ItemsService<File>;
  }

  const assetsService: typeof AssetsService = services.AssetsService;
  async function getAssetsService() {
    return new assetsService({ knex: database, schema: await getSchema() });
  }

  const itemsService: typeof ItemsService = services.ItemsService;
  async function getItemsService(collection: string) {
    return new itemsService(collection, {
      knex: database,
      schema: await getSchema(),
    });
  }

  async function ensureRequiredFields() {
    const fields = await getFieldsService();

    const thumbhashField: Record<string, any> | null = await fields
      .readOne("directus_files", "thumbhash")
      .catch(() => null);

    if (!thumbhashField) {
      await fields.createField("directus_files", {
        collection: "directus_files",
        field: "thumbhash",
        type: "string",
        schema: {
          name: "thumbhash",
          table: "directus_files",
          data_type: "varchar",
          default_value: null,
          max_length: 255,
          is_nullable: true,
          foreign_key_column: null,
          foreign_key_table: null,
          has_auto_increment: false,
          is_generated: false,
          is_primary_key: false,
          is_unique: false,
          numeric_precision: null,
          numeric_scale: null,
          comment: null,
          foreign_key_schema: null,
          generation_expression: null,
        },
        meta: {
          collection: "directus_files",
          field: "thumbhash",
          interface: "input",
          options: {
            iconLeft: "lens_blur",
          },
          display: null,
          display_options: {},
          special: null,
          group: null,
          hidden: false,
          readonly: false,
          required: false,
          sort: null,
          translations: null,
          width: null,
          note: null,
          conditions: null,
          validation: null,
          validation_message: null,
        } as any,
      });
    }
  }

  async function extractVideoFrame(
    videoPath: string,
    outputPath: string
  ): Promise<{ width: number; height: number } | null> {
    try {
      // Extract first frame
      await execAsync(
        `ffmpeg -i "${videoPath}" -vframes 1 -vf "scale=100:100:force_original_aspect_ratio=decrease" -y "${outputPath}" 2>&1`
      );

      // Get dimensions from the extracted frame using sharp
      try {
        const frameInfo = await sharp(outputPath).metadata();
        if (frameInfo.width && frameInfo.height) {
          return {
            width: frameInfo.width,
            height: frameInfo.height,
          };
        }
      } catch (error) {
        console.log("[thumbhash] failed to get frame dimensions:", error);
      }

      // Fallback: try to get dimensions from video using ffprobe
      try {
        const { stdout } = await execAsync(
          `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${videoPath}"`
        );
        const dimensionMatch = stdout.trim().match(/(\d+)x(\d+)/);
        if (dimensionMatch && dimensionMatch[1] && dimensionMatch[2]) {
          return {
            width: parseInt(dimensionMatch[1], 10),
            height: parseInt(dimensionMatch[2], 10),
          };
        }
      } catch (error) {
        console.log("[thumbhash] failed to get video dimensions from ffprobe:", error);
      }

      return null;
    } catch (error) {
      console.log("[thumbhash] failed to extract video frame:", error);
      return null;
    }
  }

  async function generateThumbHash(key: string, force: boolean = false) {
    const assets = await getAssetsService();
    const files = await getFilesService();

    const file = (await files.readOne(key, {
      fields: ["id", "thumbhash", "type", "width", "height", "filename_disk"],
    })) as File & {
      thumbhash?: string | null;
      filename_disk?: string | null;
    };

    if (!file) {
      console.log("[thumbhash] failed to fetch file with key: ", key);
      return;
    }

    if ((file.thumbhash || "").length > 0 && !force) {
      console.log("[thumbhash] file already has thumbhash: ", key);
      return;
    }

    const isImage = file.type?.startsWith("image/") && !file.type?.includes("svg");
    const isVideo = file.type?.startsWith("video/");

    if (!isImage && !isVideo) {
      console.log("[thumbhash] skipping unsupported file type: ", file.type);
      return;
    }

    let imageBuffer: Buffer;
    let imageInfo: { width: number; height: number };

    if (isVideo) {
      // Handle video: extract first frame
      const videoTempPath = join(tmpdir(), `thumbhash-video-${randomUUID()}.tmp`);
      const frameOutputPath = join(tmpdir(), `thumbhash-frame-${randomUUID()}.jpg`);

      try {
        // Get video stream from AssetsService
        const videoAsset = await assets.getAsset(file.id, {
          transformationParams: {},
        });

        // Save video stream to temporary file
        const videoChunks: Buffer[] = [];
        for await (const chunk of videoAsset.stream) {
          videoChunks.push(chunk);
        }
        await writeFile(videoTempPath, Buffer.concat(videoChunks));

        // Extract first frame using ffmpeg
        const dimensions = await extractVideoFrame(videoTempPath, frameOutputPath);
        
        // Clean up temporary video file
        try {
          await unlink(videoTempPath);
        } catch (error) {
          // Ignore cleanup errors
        }

        if (!dimensions) {
          console.log("[thumbhash] failed to extract video frame dimensions");
          // Clean up frame file if it exists
          try {
            await unlink(frameOutputPath);
          } catch (error) {
            // Ignore cleanup errors
          }
          return;
        }

        // Read the extracted frame
        const frameBuffer = await readFile(frameOutputPath);

        // Clean up temporary frame file
        try {
          await unlink(frameOutputPath);
        } catch (error) {
          // Ignore cleanup errors
        }

        // Process frame with sharp
        const processed = await new Promise<
          | {
              buffer: Buffer;
              info: {
                width: number;
                height: number;
              };
            }
          | {
              error: Error;
            }
        >(async (resolve, reject) => {
          try {
            sharp(frameBuffer)
              .raw()
              .ensureAlpha()
              .toBuffer(
                (
                  error: Error,
                  buffer: Buffer,
                  info: { width: number; height: number }
                ) => {
                  if (error) {
                    reject(error);
                  }
                  resolve({
                    buffer,
                    info,
                  });
                }
              );
          } catch (error) {
            console.log(error);
            resolve({
              error,
            });
          }
        });

        if ("error" in processed) {
          console.log(
            "[thumbhash] failed to process video frame: ",
            processed.error.message
          );
          return;
        }

        imageBuffer = processed.buffer;
        imageInfo = processed.info;
      } catch (error) {
        // Clean up temporary files on error
        try {
          await unlink(videoTempPath).catch(() => {});
          await unlink(frameOutputPath).catch(() => {});
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
        console.log("[thumbhash] video processing error: ", error);
        return;
      }
    } else {
      // Handle image: use existing logic
      if (
        file.width === null ||
        file.height === null
      ) {
        console.log("[thumbhash] image missing dimensions: ", file.type);
        return;
      }

      let resize = {
        width:
          file.width > file.height
            ? 100
            : file.width == file.height
            ? 100
            : undefined,
        height:
          file.height > file.width
            ? 100
            : file.width == file.height
            ? 100
            : undefined,
      };

      const asset = await assets.getAsset(file.id, {
        transformationParams: {
          key: undefined,
          withoutEnlargement: true,
          format: "webp",
          ...resize,
        },
        // Keep for backwards compatibility
        ...{
          key: undefined,
          withoutEnlargement: true,
          format: "webp",
          ...resize,
        },
      });

      const chunks: Buffer[] = [];
      for await (const chunk of asset.stream) {
        chunks.push(chunk);
      }

      const image = await new Promise<
        | {
            buffer: Buffer;
            info: {
              width: number;
              height: number;
            };
          }
        | {
            error: Error;
          }
      >(async (resolve, reject) => {
        try {
          sharp(Buffer.concat(chunks))
            .raw()
            .ensureAlpha()
            .toBuffer(
              (
                error: Error,
                buffer: Buffer,
                info: { width: number; height: number }
              ) => {
                if (error) {
                  reject(error);
                }
                resolve({
                  buffer,
                  info,
                });
              }
            );
        } catch (error) {
          console.log(error);
          // reject(error);
          resolve({
            error,
          });
        }
      });

      if ("error" in image) {
        console.log(
          "[thumbhash] failed to generate image: ",
          image.error.message
        );
        return;
      }

      imageBuffer = image.buffer;
      imageInfo = image.info;
    }

    const hash = Buffer.from(
      thumbhash.rgbaToThumbHash(
        imageInfo.width,
        imageInfo.height,
        imageBuffer
      )
    ).toString("base64");

    await files.updateOne(file.id, { thumbhash: hash });
  }

  async function detectAudioFromFile(fileId: string): Promise<boolean> {
    const assets = await getAssetsService();
    const files = await getFilesService();

    const file = (await files.readOne(fileId, {
      fields: ["id", "type", "filename_disk"],
    })) as File & { filename_disk?: string | null };

    if (!file) {
      console.log("[has_audio] file not found:", fileId);
      return false;
    }

    if (!file.type?.startsWith("video/")) {
      console.log("[has_audio] skipping non-video file:", file.type);
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
      await writeFile(tempPath, Buffer.concat(videoChunks));

      // ffmpeg exits non-zero for -f null output — that is expected, so we catch and read stderr
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
        console.log(`[has_audio] file ${fileId}: max_volume=${maxVolume}dB → ${hasAudio}`);
        return hasAudio;
      }

      console.log("[has_audio] volumedetect output not found for file:", fileId);
      return false;
    } catch (error) {
      console.log("[has_audio] audio detection error for file:", fileId, error);
      return false;
    } finally {
      try {
        await unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  init("routes.custom.after", async () => {
    await ensureRequiredFields();
  });

  action(
    "files.upload",
    async function (
      { payload, key, collection },
      { database, schema, accountability }
    ) {
      try {
        await generateThumbHash(key, true);
      } catch (error) {
        console.log("[thumbhash] file update error: " + error);
      }
    }
  );

  action(
    "files.update",
    async function (
      { payload, keys, collection },
      { database, schema, accountability }
    ) {
      for await (const key of keys) {
        try {
          await generateThumbHash(key, false);
        } catch (error) {
          console.log("[thumbhash] file update error: " + error);
        }
      }
    }
  );

  // Auto-detect audio when a reel or promotion is created with a media file
  action(
    "items.create",
    async function ({ payload, key, collection }, _ctx) {
      if (collection === "hotel_reels" || collection === "hotel_promotions") {
        const fileId = payload?.media;
        if (!fileId) return;
        try {
          const hasAudio = await detectAudioFromFile(fileId);
          const items = await getItemsService(collection);
          await items.updateOne(key, { has_audio: hasAudio });
          console.log(`[has_audio] ${collection}/${key}: has_audio=${hasAudio}`);
        } catch (error) {
          console.log(`[has_audio] ${collection}.items.create error:`, error);
        }
      }

      // Junction table: a file was linked to a reels record
      if (collection === "reels_files_1") {
        const fileId = payload?.directus_files_id;
        const reelId = payload?.reels_id;
        if (!fileId || !reelId) return;
        try {
          const hasAudio = await detectAudioFromFile(fileId);
          const reels = await getItemsService("reels");
          await reels.updateOne(reelId, { has_audio: hasAudio });
          console.log(`[has_audio] reels/${reelId}: has_audio=${hasAudio}`);
        } catch (error) {
          console.log("[has_audio] reels_files_1.items.create error:", error);
        }
      }
    }
  );

  // Re-detect audio when the media file is replaced on an existing record
  action(
    "items.update",
    async function ({ payload, keys, collection }, _ctx) {
      if (collection === "hotel_reels" || collection === "hotel_promotions") {
        const fileId = payload?.media;
        if (!fileId) return;
        try {
          const hasAudio = await detectAudioFromFile(fileId);
          const items = await getItemsService(collection);
          for (const key of keys) {
            await items.updateOne(key, { has_audio: hasAudio });
          }
          console.log(`[has_audio] updated ${keys.length} ${collection} record(s): has_audio=${hasAudio}`);
        } catch (error) {
          console.log(`[has_audio] ${collection}.items.update error:`, error);
        }
      }

      if (collection === "reels_files_1") {
        const fileId = payload?.directus_files_id;
        if (!fileId) return;
        try {
          const hasAudio = await detectAudioFromFile(fileId);
          const junctionService = await getItemsService("reels_files_1");
          const reels = await getItemsService("reels");
          for (const key of keys) {
            const junction = await junctionService.readOne(key, { fields: ["reels_id"] }) as any;
            if (junction?.reels_id) {
              await reels.updateOne(junction.reels_id, { has_audio: hasAudio });
              console.log(`[has_audio] reels/${junction.reels_id}: has_audio=${hasAudio}`);
            }
          }
        } catch (error) {
          console.log("[has_audio] reels_files_1.items.update error:", error);
        }
      }
    }
  );
}) as any;
