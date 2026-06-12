import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RedisClient } from "./redis.js";

/**
 * Lua script registry (adapters layer). Loads each script's source once, then
 * runs checks via EVALSHA. If Redis has forgotten the script (NOSCRIPT — after
 * a restart, failover, or SCRIPT FLUSH) we transparently re-LOAD and retry.
 * This keeps the hot path to a single round-trip (just the 40-char SHA on the
 * wire) while staying correct across Redis lifecycle events.
 *
 * `any` is allowed here: EVALSHA replies are untyped at the ioredis boundary.
 */

export type ScriptName = "token_bucket" | "sliding_window";

/** Raw reply both scripts return: [allowed, remaining, retryAfterMs, resetMs]. */
export type LuaReply = [number, number, number, number];

function loadSource(file: string): string {
  const url = new URL(`./lua/${file}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SOURCES: Record<ScriptName, string> = {
  token_bucket: loadSource("token_bucket.lua"),
  sliding_window: loadSource("sliding_window.lua"),
};

export class LuaScripts {
  private readonly shas = new Map<ScriptName, string>();

  constructor(private readonly redis: RedisClient) {}

  /** SCRIPT LOAD both scripts at startup so the first request is already warm. */
  async load(): Promise<void> {
    for (const name of Object.keys(SOURCES) as ScriptName[]) {
      const sha = (await this.redis.script("LOAD", SOURCES[name])) as string;
      this.shas.set(name, sha);
    }
  }

  source(name: ScriptName): string {
    return SOURCES[name];
  }

  /** SHA for `name`, loading on demand if startup load was skipped. */
  async sha(name: ScriptName): Promise<string> {
    let sha = this.shas.get(name);
    if (!sha) {
      sha = (await this.redis.script("LOAD", SOURCES[name])) as string;
      this.shas.set(name, sha);
    }
    return sha;
  }

  /**
   * Run a script by name with EVALSHA, recovering from NOSCRIPT by reloading
   * the source and retrying once.
   */
  async run(name: ScriptName, keys: string[], args: (string | number)[]): Promise<LuaReply> {
    const sha = await this.sha(name);
    try {
      return (await this.evalsha(sha, keys, args)) as LuaReply;
    } catch (err) {
      if (isNoScript(err)) {
        const fresh = (await this.redis.script("LOAD", SOURCES[name])) as string;
        this.shas.set(name, fresh);
        return (await this.evalsha(fresh, keys, args)) as LuaReply;
      }
      throw err;
    }
  }

  /**
   * Run many checks in ONE pipelined round-trip (the batch endpoint). Each
   * item is an independent EVALSHA; results return positionally. A NOSCRIPT on
   * any item is recovered by reloading and re-running just that item.
   */
  async runMany(
    items: { name: ScriptName; keys: string[]; args: (string | number)[] }[],
  ): Promise<LuaReply[]> {
    if (items.length === 0) return [];

    const shas = await Promise.all(items.map((it) => this.sha(it.name)));
    const pipe = this.redis.pipeline();
    items.forEach((it, i) => {
      pipe.evalsha(shas[i] as string, it.keys.length, ...it.keys, ...it.args);
    });
    const res = (await pipe.exec()) ?? [];

    const out: LuaReply[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = res[i];
      const err = entry?.[0] as Error | null | undefined;
      const val = entry?.[1];
      if (err && isNoScript(err)) {
        out.push(await this.run(items[i]!.name, items[i]!.keys, items[i]!.args));
      } else if (err) {
        throw err;
      } else {
        out.push(val as LuaReply);
      }
    }
    return out;
  }

  private evalsha(sha: string, keys: string[], args: (string | number)[]): Promise<any> {
    // ioredis signature: evalsha(sha, numkeys, ...keys, ...args)
    return (this.redis as any).evalsha(sha, keys.length, ...keys, ...args);
  }
}

function isNoScript(err: unknown): boolean {
  return err instanceof Error && err.message.includes("NOSCRIPT");
}
