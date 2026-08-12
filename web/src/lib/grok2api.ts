/** Grok2API image/video parameter mapping. Keep pure helpers so official merges stay local. */

import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

const IMAGE_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2"] as const;
/** Official Grok video aspect ratios (xAI docs: 1:1, 16:9/9:16, 4:3/3:4, 3:2/2:3). */
export const GROK2API_VIDEO_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
/** Base resolutions for all Grok video models (official default 480p). */
export const GROK2API_VIDEO_RESOLUTIONS = ["480p", "720p"] as const;
/** 1080p only on grok-imagine-video-1.5 for T2V/I2V; R2V is capped at 720p. */
export const GROK2API_VIDEO_RESOLUTIONS_1_5 = ["480p", "720p", "1080p"] as const;
export const GROK2API_VIDEO_DURATION_OPTIONS = [1, 4, 6, 8, 10, 12, 15] as const;
/** Official extension segment length (seconds). */
export const GROK2API_VIDEO_EXTEND_DURATION_OPTIONS = [2, 4, 6, 8, 10] as const;
/** Max items in `reference_images` (R2V). Official API forbids combining with first-frame `image`. */
export const GROK2API_VIDEO_REFERENCE_IMAGE_LIMIT = 8;

export type Grok2apiVideoWorkflow = "generate" | "edit" | "extend";
export type Grok2apiVideoGenerateMode = "t2v" | "i2v" | "r2v";

/** Strip channel encoding (`channelId::model`) and provider prefixes for comparisons. */
export function bareGrok2apiModelId(model: string | undefined) {
	let id = (model || "").trim();
	const sep = id.indexOf("::");
	if (sep >= 0) id = id.slice(sep + 2);
	return id.toLowerCase().replace(/^console\//, "").replace(/^web\//, "").replace(/^build\//, "");
}

/** True when public model id is grok-imagine-video-1.5 (with optional channel / Console/ prefix). */
export function isGrok2apiVideo15(model: string | undefined) {
	const id = bareGrok2apiModelId(model);
	return id === "grok-imagine-video-1.5" || id.endsWith("/grok-imagine-video-1.5");
}

/** Resolutions allowed for the selected model and generate mode (official caps). */
export function grok2apiVideoResolutionsFor(model: string | undefined, generateMode: Grok2apiVideoGenerateMode = "t2v") {
	// Official: R2V is capped at 720p even on 1.5.
	if (generateMode === "r2v") return [...GROK2API_VIDEO_RESOLUTIONS] as string[];
	if (isGrok2apiVideo15(model)) return [...GROK2API_VIDEO_RESOLUTIONS_1_5] as string[];
	return [...GROK2API_VIDEO_RESOLUTIONS] as string[];
}

function parseRatio(value: string): { w: number; h: number } | null {
    const ratio = value.trim().match(/^(\d+(?:\.\d+)?)\s*[:/xX]\s*(\d+(?:\.\d+)?)$/);
    if (!ratio) return null;
    const w = Number(ratio[1]);
    const h = Number(ratio[2]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { w, h };
}

function closestRatio(value: string | undefined, supported: readonly string[], fallback: string) {
    if (!value || value.trim().toLowerCase() === "auto") return fallback;
    const normalized = value.trim().replace(/[xX/]/g, ":");
    if (supported.includes(normalized)) return normalized;
    const parsed = parseRatio(normalized);
    if (!parsed) return fallback;
    const target = parsed.w / parsed.h;
    return supported.reduce((best, item) => {
        const [bw, bh] = best.split(":").map(Number);
        const [iw, ih] = item.split(":").map(Number);
        const bestDiff = Math.abs(bw / bh - target);
        const itemDiff = Math.abs(iw / ih - target);
        return itemDiff < bestDiff ? item : best;
    });
}

/** Map canvas size (ratio or WxH) to Grok2API image aspect_ratio. */
export function grok2apiImageAspectRatio(size: string | undefined) {
    return closestRatio(size, IMAGE_ASPECT_RATIOS, "1:1");
}

/** Map canvas quality to Grok2API image resolution (1k/2k). */
export function grok2apiImageResolution(quality: string | undefined) {
    const value = (quality || "").trim().toLowerCase();
    if (value === "high" || value === "hd" || value === "2k" || value === "4k" || value === "medium") return "2k";
    return "1k";
}

/** Map canvas size to Grok2API video aspect_ratio. */
export function grok2apiVideoAspectRatio(size: string | undefined) {
    return closestRatio(size, GROK2API_VIDEO_ASPECT_RATIOS, "16:9");
}

/** Closest official video ratio for a pixel size (used when size=auto + first frame). */
export function grok2apiVideoAspectRatioFromDimensions(width: number, height: number) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "16:9";
    return closestRatio(`${width}:${height}`, GROK2API_VIDEO_ASPECT_RATIOS, "16:9");
}

/** True when the UI size means "pick automatically". */
export function isGrok2apiAutoVideoSize(size: string | undefined) {
    const value = (size || "").trim().toLowerCase();
    return !value || value === "auto" || value === "adaptive";
}

/** Map canvas video quality to Grok2API video resolution (480p/720p/1080p). */
export function grok2apiVideoResolution(quality: string | undefined, options?: { model?: string; generateMode?: Grok2apiVideoGenerateMode }) {
    const value = (quality || "").trim().toLowerCase();
    let resolution = "720p";
    if (value === "low" || value === "480" || value === "480p") resolution = "480p";
    else if (value === "high" || value === "hd" || value === "1080" || value === "1080p" || value === "4k") resolution = "1080p";
    else if (value === "720" || value === "720p" || value === "auto" || value === "medium" || !value) resolution = "720p";
    else {
        const bare = value.replace(/p$/i, "");
        if (bare === "480") resolution = "480p";
        else if (bare === "1080") resolution = "1080p";
        else resolution = "720p";
    }
    const allowed = grok2apiVideoResolutionsFor(options?.model, options?.generateMode || "t2v");
    if (!allowed.includes(resolution)) {
        // Fall back to highest allowed (720p when 1080p is not permitted).
        return allowed.includes("720p") ? "720p" : allowed[0] || "480p";
    }
    return resolution;
}

/** Extension duration 2–10s (official), default 6. */
export function grok2apiVideoExtendDuration(seconds: string | number | undefined) {
    const n = Math.floor(Number(seconds) || 6);
    return Math.max(2, Math.min(10, n));
}

/** Clamp canvas video seconds to Grok2API duration (1–15, default 8 to match API). */
export function grok2apiVideoDuration(seconds: string | number | undefined) {
    const n = Math.floor(Number(seconds) || 8);
    return Math.max(1, Math.min(15, n));
}

export function isGrok2apiVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "apiFormat">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return requestConfig.apiFormat === "grok2api";
}

export function normalizeGrok2apiVideoRatio(value: string | undefined) {
    return grok2apiVideoAspectRatio(value);
}

export function normalizeGrok2apiVideoResolution(value: string | undefined, options?: { model?: string; generateMode?: Grok2apiVideoGenerateMode }) {
    return grok2apiVideoResolution(value, options);
}

export function normalizeGrok2apiVideoDuration(value: string | number | undefined) {
    return grok2apiVideoDuration(value);
}
