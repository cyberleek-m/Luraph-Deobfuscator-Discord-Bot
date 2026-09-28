import {
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  OAuth2Scopes,
  PermissionFlagsBits,
  type Message,
} from "discord.js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { logger } from "../lib/logger";

const PREFIX = process.env.DISCORD_PREFIX ?? "!";
const BRAND_NAME = "WhaleHub";
const WATERMARK = "-- generated at .gg/bonnieblue";
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_RAW_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const MAX_CONCURRENT_JOBS = clampInteger(
  process.env.MAX_CONCURRENT_DEOBF_JOBS,
  1,
  4,
  2,
);
const USER_COOLDOWN_MS = 10_000;
const JOB_TIMEOUT_MS = 5 * 60 * 1_000;
const DEOB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../deobfuscator",
);
const DEOB_ENTRY = path.join(DEOB_ROOT, "deob.js");

const BOOLEAN_FLAGS = new Set([
  "--no-devirt",
  "--no-hooks",
  "--no-fold",
  "--debug",
  "--strings",
  "--keep-harness",
  "--keep-preamble",
  "--detect",
]);

const NUMERIC_FLAGS = new Map([
  ["--timeout", { min: 1, max: 180 }],
  ["--budget", { min: 1, max: 120 }],
  ["--max-runs", { min: 1, max: 50 }],
  ["--devirt-rounds", { min: 1, max: 1_000 }],
]);

const VALUE_FLAGS = new Set(["--timeout", "--budget", "--max-runs", "--devirt-rounds", "--executor"]);

type ParsedOptions = {
  cliArgs: string[];
  detect: boolean;
  debug: boolean;
};

type InputFile = {
  name: string;
  bytes: Buffer;
};

const cooldowns = new Map<string, number>();
let activeJobs = 0;

function clampInteger(value: string | undefined, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function addWatermark(output: Buffer) {
  return Buffer.concat([Buffer.from(`${WATERMARK}\n\n`, "utf8"), output]);
}

function buildPreview(output: Buffer) {
  const lines = output
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && line.trim() !== WATERMARK)
    .slice(0, 6);
  const preview = lines.join("\n").replace(/```/g, "'''").slice(0, 850);
  return preview || "Preview unavailable.";
}

function countOutputFunctions(output: Buffer) {
  return (output.toString("utf8").match(/\bfunction\b/g) ?? []).length;
}

function crc32(input: Buffer) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipTextFile(name: string, content: Buffer) {
  const filename = Buffer.from(name, "utf8");
  const compressed = deflateRawSync(content, { level: 9 });
  const crc = crc32(content);

  const localHeader = Buffer.alloc(30 + filename.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(filename.length, 26);
  localHeader.writeUInt16LE(0, 28);
  filename.copy(localHeader, 30);

  const centralHeader = Buffer.alloc(46 + filename.length);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(filename.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);
  filename.copy(centralHeader, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralHeader.length, 12);
  end.writeUInt32LE(localHeader.length + compressed.length, 16);

  return Buffer.concat([localHeader, compressed, centralHeader, end]);
}

function summarizeProcessFailure(stderr: string, stdout: string) {
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";

  const important = lines.filter((line) =>
    /(?:failed|error|invalid argument|attempt to|compile error|script error|timed out|function render)/i.test(
      line,
    ),
  );
  const selected = [...new Set([...important.slice(0, 5), ...lines.slice(-8)])];
  return selected.join("\n").slice(0, 2_000);
}

function tokenize(input: string) {
  return input.match(/--[A-Za-z0-9-]+(?:=(?:"[^"]*"|'[^']*'|[^\s]+))?|[^\s]+/g) ?? [];
}

function parseOptions(content: string): ParsedOptions {
  const tokens = tokenize(content);
  const cliArgs: string[] = [];
  let detect = false;
  let debug = false;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument "${token}". Put the Lua source in an attachment or code block.`);
    }

    const equalsIndex = token.indexOf("=");
    const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    let value = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);

    if (BOOLEAN_FLAGS.has(flag)) {
      if (value !== undefined) {
        throw new Error(`${flag} does not accept a value.`);
      }
      cliArgs.push(flag);
      if (flag === "--detect") detect = true;
      if (flag === "--debug") debug = true;
      continue;
    }

    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(`Unknown macro "${flag}". Use ${PREFIX}help to see supported macros.`);
    }

    if (value === undefined) {
      value = tokens[index + 1];
      index += 1;
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} needs a value.`);
    }

    if (NUMERIC_FLAGS.has(flag)) {
      const limits = NUMERIC_FLAGS.get(flag);
      const parsed = Number(value);
      if (!limits || !Number.isInteger(parsed) || parsed < limits.min || parsed > limits.max) {
        throw new Error(`${flag} must be an integer from ${limits?.min ?? 1} to ${limits?.max ?? 1}.`);
      }
    } else if (flag === "--executor" && !["Wave", "wave", "Legacy", "legacy"].includes(value)) {
      throw new Error(`${flag} must be Wave or Legacy.`);
    }

    cliArgs.push(flag, value);
  }

  return { cliArgs, detect, debug };
}

function extractCodeBlock(content: string) {
  const match = content.match(/```(?:lua|luau)?\s*\r?\n([\s\S]*?)```/i);
  return match?.[1] ?? null;
}

function cleanAttachmentName(name: string) {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const ext = path.extname(base).toLowerCase();
  return {
    name: base || "input.lua",
    supported: ext === ".lua" || ext === ".luau",
  };
}

async function getInputFile(message: Message): Promise<InputFile> {
  const attachment = message.attachments.first();
  if (attachment) {
    const cleaned = cleanAttachmentName(attachment.name ?? "input.lua");
    if (!cleaned.supported) {
      throw new Error("Only `.lua` and `.luau` attachments are supported.");
    }
    if (attachment.size > MAX_SOURCE_BYTES) {
      throw new Error("That file is too large. The limit is 8 MiB.");
    }

    const response = await fetch(attachment.url, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Discord returned HTTP ${response.status} while downloading the attachment.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new Error("That file is too large. The limit is 8 MiB.");
    }
    return { name: cleaned.name, bytes };
  }

  const code = extractCodeBlock(message.content);
  if (!code) {
    throw new Error(`Attach a \`.lua\`/ \`.luau\` file or include a Lua code block. Example: ${PREFIX}deobf --debug`);
  }
  const bytes = Buffer.from(code, "utf8");
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new Error("That code block is too large. The limit is 8 MiB.");
  }
  return { name: "input.lua", bytes };
}

async function runDeobfuscator(
  inputPath: string,
  outputPath: string,
  cliArgs: string[],
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [DEOB_ENTRY, inputPath, "-o", outputPath, ...cliArgs], {
      cwd: DEOB_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error("The deobfuscator exceeded the 5 minute job limit."));
      }
    }, JOB_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 64_000) stdout = stdout.slice(-64_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });
  });
}

async function processJob(input: InputFile, options: ParsedOptions) {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "luraph-discord-"));
  const inputPath = path.join(workdir, input.name);
  const outputPath = path.join(workdir, `${path.basename(input.name, path.extname(input.name))}.deobf.luau`);

  try {
    await writeFile(inputPath, input.bytes);
    const result = await runDeobfuscator(inputPath, outputPath, options.cliArgs);

    if (options.detect) {
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "Detection failed.");
      }
      return { kind: "text" as const, content: result.stdout.trim() || "No obfuscator detected." };
    }

    if (result.code !== 0) {
      const detail = summarizeProcessFailure(result.stderr, result.stdout);
      throw new Error(detail || "The deobfuscator could not process this file.");
    }

    const outputStat = await stat(outputPath).catch(() => null);
    if (!outputStat || outputStat.size === 0) {
      throw new Error("The deobfuscator finished without producing an output file.");
    }
    if (outputStat.size > MAX_RAW_OUTPUT_BYTES) {
      throw new Error("The raw output is larger than the bot's 32 MiB processing limit.");
    }

    const output = addWatermark(await readFile(outputPath));
    const baseName = path.basename(outputPath, path.extname(outputPath));
    const archived = output.length > MAX_ATTACHMENT_BYTES;
    const attachmentBytes = archived
      ? zipTextFile(`${baseName}.txt`, output)
      : output;
    if (attachmentBytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error("The output is too large to send to Discord, even as a ZIP archive.");
    }
    return {
      kind: "file" as const,
      name: archived ? `${baseName}.txt.zip` : `${baseName}.txt`,
      bytes: attachmentBytes,
      debug: options.debug,
      archived,
      functionCount: countOutputFunctions(output),
      lineCount: output.toString("utf8").split(/\r?\n/).length,
      preview: buildPreview(output),
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function helpText() {
  return [
    `**${PREFIX}deobf** — deobfuscate one Luraph v15 Luau script`,
    "",
    `Attach a \`.lua\` or \`.luau\` file, then use for example:`,
    `\`${PREFIX}deobf --debug\``,
    "",
    "**Supported macros**",
    "`--no-devirt` fast trace mode",
    "`--no-hooks` disable VM closure instrumentation",
    "`--no-fold` disable trace folding",
    "`--debug` keep intermediate files during the job",
    "`--strings` include string-focused trace output",
    "`--keep-harness` keep the generated harness",
    "`--keep-preamble` keep the generated preamble",
    "`--detect` detect the obfuscator without deobfuscating",
    "`--timeout N` 1–180 seconds per runtime pass",
    "`--budget N` 1–120 runtime budget",
    "`--max-runs N` 1–50 anti-tamper reruns",
    "`--devirt-rounds N` 1–1000 decryption rounds",
    "`--executor Wave|Legacy` choose the executor mode",
    "",
    `Jobs are limited to ${MAX_SOURCE_BYTES / 1024 / 1024} MiB input, ${MAX_RAW_OUTPUT_BYTES / 1024 / 1024} MiB raw output, ${MAX_CONCURRENT_JOBS} concurrent job${MAX_CONCURRENT_JOBS === 1 ? "" : "s"}, and a 10 second per-user cooldown.`,
  ].join("\n");
}

async function handleMessage(message: Message) {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const command = message.content.slice(PREFIX.length).trim().split(/\s+/, 1)[0].toLowerCase();
  if (command === "help" || command === "commands") {
    await message.reply({ content: helpText() });
    return;
  }
  if (command === "ping") {
    await message.reply({ content: "pong" });
    return;
  }
  if (command !== "deobf" && command !== "deobfuscate") return;

  const userId = message.author.id;
  const lastRun = cooldowns.get(userId) ?? 0;
  const remaining = USER_COOLDOWN_MS - (Date.now() - lastRun);
  if (remaining > 0) {
    await message.reply({ content: `Please wait ${Math.ceil(remaining / 1000)}s before starting another job.` });
    return;
  }
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    await message.reply({ content: "The bot is busy processing other jobs. Try again in a moment." });
    return;
  }

  let options: ParsedOptions;
  try {
    const commandText = message.content.slice(PREFIX.length).trim();
    options = parseOptions(commandText.split("```", 1)[0].trim());
  } catch (error) {
    await message.reply({ content: `Invalid command: ${errorMessage(error)}` });
    return;
  }

  cooldowns.set(userId, Date.now());
  activeJobs += 1;
  const started = Date.now();
  let progress: Message | null = null;
  try {
    const input = await getInputFile(message);
    progress = await message.reply({ content: `Processing \`${input.name}\`…` });
    const result = await processJob(input, options);

    if (result.kind === "text") {
      await progress.edit({ content: `\`\`\`\n${result.content.slice(0, 1_800)}\n\`\`\`` });
    } else {
      const attachment = new AttachmentBuilder(result.bytes, { name: result.name });
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const notes = [
        result.archived ? "ZIP with readable TXT" : null,
        result.debug ? "debug macros enabled" : null,
      ].filter((note): note is string => note !== null);
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("✅ Deobfuscation complete")
        .setDescription("Your cleaned script is attached below.")
        .addFields(
          { name: "Input", value: `\`${input.name}\``, inline: true },
          { name: "Obfuscator", value: "Luraph v15", inline: true },
          { name: "Mode", value: `🏷️ Watermarked (${BRAND_NAME})`, inline: true },
          { name: "Functions", value: String(result.functionCount), inline: true },
          { name: "Lines", value: String(result.lineCount), inline: true },
          { name: "Time", value: `${elapsed}s`, inline: true },
          {
            name: "Preview (first 6 lines)",
            value: `\`\`\`lua\n${result.preview}\n\`\`\``,
          },
        )
        .setFooter({ text: `${BRAND_NAME} DEOBFUSCATOR` });
      await progress.edit({
        content: notes.length > 0 ? notes.join(" · ") : null,
        embeds: [embed],
        files: [attachment],
      });
    }
  } catch (error) {
    const detail = errorMessage(error).slice(0, 1_700);
    const hint = /harness|function render|script error/i.test(detail)
      ? `\nTry \`${PREFIX}deobf --no-devirt\` for the fast behaviour-trace mode.`
      : "";
    const content = `Deobfuscation failed:\n${detail}${hint}`;
    if (progress) {
      await progress.edit({ content }).catch(() => undefined);
    } else {
      await message.reply({ content }).catch(() => undefined);
    }
    logger.warn({ err: error, userId, command }, "Discord deobfuscation job failed");
  } finally {
    activeJobs -= 1;
  }
}

export async function startDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN is not configured; Discord bot is disabled");
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  client.once(Events.ClientReady, (readyClient) => {
    const invite = readyClient.generateInvite({
      permissions: [PermissionFlagsBits.Administrator],
      scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    });
    logger.info({ tag: readyClient.user.tag, prefix: PREFIX, invite }, "Discord bot ready");
  });
  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message).catch((error) => {
      logger.error({ err: error }, "Unhandled Discord message error");
    });
  });
  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  try {
    await client.login(token);
  } catch (error) {
    logger.error({ err: error }, "Discord bot login failed");
  }
}