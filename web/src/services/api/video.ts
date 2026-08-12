import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { dataUrlToFile, readImageMeta } from "@/lib/image-utils";
import { GROK2API_VIDEO_REFERENCE_IMAGE_LIMIT, grok2apiVideoAspectRatio, grok2apiVideoAspectRatioFromDimensions, grok2apiVideoDuration, grok2apiVideoExtendDuration, grok2apiVideoResolution, isGrok2apiAutoVideoSize, isGrokImagineVideoModel, type Grok2apiVideoGenerateMode, type Grok2apiVideoWorkflow } from "@/lib/grok2api";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id?: string; request_id?: string; status?: string; progress?: number; model?: string; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; video?: { url?: string } | null; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "completed" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; url?: string; last_frame_url?: string } | null;
    url?: string;
    result_url?: string;
    video_url?: string;
};
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "plugin" | "grok2api"; model: string; workflow?: "generate" | "edit" | "extend" };
export type VideoGenerationTaskState =
    | { status: "pending"; progress?: number; message?: string }
    | { status: "completed"; result: VideoGenerationResult }
    | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions & { firstFrame?: ReferenceImage | null }): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    const delayMs = task.provider === "seedance" ? 5000 : 2500;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === 119) throw new Error(apiText("videoTimeout", { provider: task.provider === "seedance" ? "Seedance " : task.provider === "grok2api" ? "Grok2API " : "" }));
        await delay(delayMs, options?.signal);
    }
    throw new Error(apiText("videoTimeout", { provider: "" }));
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions & { firstFrame?: ReferenceImage | null; workflow?: Grok2apiVideoWorkflow; sourceVideoUrl?: string; sourceVideo?: ReferenceVideo | null }): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (isSeedanceVideoConfig(requestConfig)) {
        // Seedance has no first-frame field; prepend optional first frame into image refs.
        const seedanceImages = options?.firstFrame ? [options.firstFrame, ...references] : references;
        return createSeedanceTask(requestConfig, selectedModel, prompt, seedanceImages, videoReferences, audioReferences, options);
    }
    // apiFormat grok2api, or model is grok-imagine-video* while channel still marked openai
    if (requestConfig.apiFormat === "grok2api" || isGrokImagineVideoModel(selectedModel)) {
        const workflow = options?.workflow || "generate";
        if (workflow === "generate" && (videoReferences.length || audioReferences.length)) {
            throw new Error(apiText("videoReferencesUnsupported"));
        }
        return createGrok2apiVideoTask(requestConfig, selectedModel, prompt, references, options);
    }
    if (videoReferences.length || audioReferences.length) {
        throw new Error(apiText("videoReferencesUnsupported"));
    }
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("pluginVideoExpired") };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "seedance") return pollSeedanceTask(requestConfig, task, options);
    if (task.provider === "grok2api") return pollGrok2apiVideoTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: config.size,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error(apiText("scriptNoVideo"));
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) {
        try {
            return await uploadMediaFile(result.url, "video");
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error(apiText("noPlayableVideo"));
}

async function createGrok2apiVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions & { firstFrame?: ReferenceImage | null; workflow?: Grok2apiVideoWorkflow; sourceVideoUrl?: string; sourceVideo?: ReferenceVideo | null }): Promise<VideoGenerationTask> {
    const workflow: Grok2apiVideoWorkflow = options?.workflow || "generate";
    if (workflow === "edit" || workflow === "extend") {
        return createGrok2apiVideoMutationTask(config, model, prompt, workflow, options);
    }
    const firstFrame = options?.firstFrame || null;
    // Official xAI rule: `image` and `reference_images` are mutually exclusive (400 if both are set).
    // Prefer explicit first-frame image-to-video when both are provided; never auto-promote refs to first frame.
    const useFirstFrame = Boolean(firstFrame);
    const firstFrameUrl = useFirstFrame ? await imageToDataUrl(firstFrame!) : "";
    const referenceUrls = useFirstFrame
        ? []
        : (await Promise.all(references.slice(0, GROK2API_VIDEO_REFERENCE_IMAGE_LIMIT).map((image) => imageToDataUrl(image)))).filter(Boolean);
    const promptText = prompt.trim();
    const generateMode: Grok2apiVideoGenerateMode = firstFrameUrl ? "i2v" : referenceUrls.length ? "r2v" : "t2v";

    const aspectRatio = await resolveGrok2apiVideoAspectRatio(config.size, firstFrameUrl || undefined);
    // Shape: model/prompt/duration/aspect_ratio/resolution + either image XOR reference_images.
    // Strict JSON rejects unknown fields such as n / images / seconds / size / quality.
    const payload: Record<string, unknown> = {
        model: modelOptionName(model),
        aspect_ratio: aspectRatio,
        resolution: grok2apiVideoResolution(config.vquality, { model, generateMode }),
        duration: grok2apiVideoDuration(config.videoSeconds),
    };
    if (promptText) payload.prompt = promptText;
    if (firstFrameUrl) payload.image = { url: firstFrameUrl };
    else if (referenceUrls.length) payload.reference_images = referenceUrls.map((url) => ({ url }));
    if (!promptText && !firstFrameUrl && !referenceUrls.length) throw new Error(apiText("videoPromptRequired"));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos/generations"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        const id = created.id || created.request_id;
        if (!id) throw new Error(apiText("noVideoTaskId"));
        return { id, provider: "grok2api", model, workflow: "generate" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function createGrok2apiVideoMutationTask(
    config: AiConfig,
    model: string,
    prompt: string,
    workflow: "edit" | "extend",
    options?: RequestOptions & { sourceVideoUrl?: string; sourceVideo?: ReferenceVideo | null },
): Promise<VideoGenerationTask> {
    const promptText = prompt.trim();
    if (!promptText) throw new Error(apiText("videoPromptRequired"));
    // Local uploads are stored as blob: object URLs — servers cannot fetch those.
    // Resolve storageKey/blob to a data URL (or keep https) before POST.
    const sourceUrl = await resolveGrok2apiSourceVideoUrl(options?.sourceVideo || { url: options?.sourceVideoUrl || "" });
    // Official Console edit/extend only accept grok-imagine-video (not 1.5) today.
    const rawModel = modelOptionName(model).replace(/^Console\//i, "");
    const editModel = /grok-imagine-video/i.test(rawModel) ? "grok-imagine-video" : rawModel;
    const payload: Record<string, unknown> = {
        model: editModel,
        prompt: promptText,
        video: { url: sourceUrl },
    };
    if (workflow === "extend") {
        payload.duration = grok2apiVideoExtendDuration(config.videoSeconds);
    }
    const path = workflow === "edit" ? "/videos/edits" : "/videos/extensions";
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, path), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        const id = created.id || created.request_id;
        if (!id) throw new Error(apiText("noVideoTaskId"));
        return { id, provider: "grok2api", model, workflow };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function resolveGrok2apiVideoAspectRatio(size: string | undefined, firstFrameDataUrl?: string) {
    // With a first frame + auto size, match the frame so upstream does not squash it to 16:9.
    if (isGrok2apiAutoVideoSize(size) && firstFrameDataUrl) {
        try {
            const meta = await readImageMeta(firstFrameDataUrl);
            return grok2apiVideoAspectRatioFromDimensions(meta.width, meta.height);
        } catch {
            return "16:9";
        }
    }
    // API requires a concrete ratio (empty/auto not accepted); default 16:9 without a frame.
    if (isGrok2apiAutoVideoSize(size)) return "16:9";
    return grok2apiVideoAspectRatio(size);
}

async function pollGrok2apiVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const status = (video.status || "").toLowerCase();
        const rawUrl = videoResultUrl(video);
        const progress = typeof video.progress === "number" && Number.isFinite(video.progress) ? Math.max(0, Math.min(100, Math.floor(video.progress))) : undefined;
        const terminalSuccess = status === "done" || status === "completed" || status === "succeeded" || status === "success" || Boolean(rawUrl);
        if (status === "failed" || status === "cancelled" || status === "canceled" || status === "expired") {
            return { status: "failed", error: readApiErrorMessage(video.error?.message) || apiText("videoGenerationFailed") };
        }
        if (!terminalSuccess) {
            return {
                status: "pending",
                progress,
                message: status || "pending",
            };
        }

        // Content endpoints always need the client API key. Prefer the poll URL when it is already public,
        // but always attach Authorization — bare browser/open-tab access returns invalid_api_key.
        const preferredUrl = rewriteGrok2apiMediaUrl(config, rawUrl) || aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}/content`);
        try {
            return { status: "completed", result: await downloadGrok2apiVideoContent(config, preferredUrl, options) };
        } catch (contentError) {
            if (axios.isCancel(contentError) || options?.signal?.aborted) throw contentError;
            const fallbackUrl = aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}/content`);
            if (fallbackUrl !== preferredUrl) {
                try {
                    return { status: "completed", result: await downloadGrok2apiVideoContent(config, fallbackUrl, options) };
                } catch (fallbackError) {
                    if (axios.isCancel(fallbackError) || options?.signal?.aborted) throw fallbackError;
                    throw new Error(readAxiosError(fallbackError, apiText("videoDownloadFailed")));
                }
            }
            throw new Error(readAxiosError(contentError, apiText("videoDownloadFailed")));
        }
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function downloadGrok2apiVideoContent(config: AiConfig, url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    // Always send Bearer for Grok media — /videos/*/content is auth-gated even on a public HTTPS host.
    const response = await axios.get<Blob>(url, {
        responseType: "blob",
        signal: options?.signal,
        headers: aiHeaders(config),
    });
    await assertVideoBlob(response.data);
    if (!response.data || response.data.size <= 0) throw new Error(apiText("noPlayableVideo"));
    return { blob: response.data, mimeType: response.data.type || "video/mp4" };
}

/** Map poll media URLs onto the channel baseUrl; rewrite loopback publicApiBaseURL leftovers. */
function rewriteGrok2apiMediaUrl(config: AiConfig, value?: string) {
    if (!value) return undefined;
    if (value.startsWith("data:")) return value;
    if (value.startsWith("/")) {
        const apiPath = value.replace(/^\/v1(?=\/)/, "") || value;
        return aiApiUrl(config, apiPath.startsWith("/") ? apiPath : `/${apiPath}`);
    }
    if (!isPublicMediaUrl(value)) return value;
    try {
        const parsed = new URL(value);
        if (isLoopbackHostname(parsed.hostname) || isGrok2apiContentPath(parsed.pathname)) {
            const path = parsed.pathname.replace(/^\/v1(?=\/)/, "") + parsed.search + parsed.hash;
            return aiApiUrl(config, path.startsWith("/") ? path : `/${path}`);
        }
        return value;
    } catch {
        return value;
    }
}

function isGrok2apiContentPath(pathname: string) {
    return /(?:^|\/)(?:v1\/)?videos\/[^/]+\/content\/?$/i.test(pathname || "");
}

function isLoopbackHostname(hostname: string) {
    const host = (hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "[::1]";
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readApiErrorMessage(video.error?.message) || apiText("videoGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error(apiText("seedanceAudioRequiresVisual"));
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error(apiText("videoPromptRequired"));
    const payload = {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const created = unwrapSeedanceTask((await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("seedanceNoTaskId"));
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("seedanceTaskCreateFailed")));
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapSeedanceTask((await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(state);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (state.status === "succeeded" || state.status === "completed") return { status: "failed", error: apiText("seedanceNoVideoUrl") };
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: readApiErrorMessage(state.error?.message) || apiText(state.status === "expired" ? "seedanceVideoTimeout" : "seedanceVideoFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("seedanceTaskQueryFailed")));
    }
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error(apiText("seedanceVideoDuration"));
        total += video.durationMs;
    }
    if (total > 15000) throw new Error(apiText("seedanceVideoTotalDuration"));
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error(apiText("seedanceAudioDuration"));
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error(apiText("seedanceAudioTotalDuration"));
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error(apiText("referenceImageReadFailed"));
    return dataUrl;
}

async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error(apiText("invalidReferenceVideo"));
    return blobToDataUrl(blob);
}

/** Grok2API edit/extend video.url must be HTTPS or a video data URL — never browser blob:. */
async function resolveGrok2apiSourceVideoUrl(video: { url?: string; storageKey?: string; bytes?: number; type?: string }) {
    const url = (video.url || "").trim();
    if (!url && !video.storageKey) throw new Error(apiText("invalidReferenceVideo"));
    if (url.startsWith("data:video/") && url.includes(";base64,")) return url;
    if (isPublicMediaUrl(url)) return url;
    // ~32 MiB gateway body limit; base64 expands ~4/3, leave headroom for JSON fields.
    const maxRawBytes = 20 * 1024 * 1024;
    if (typeof video.bytes === "number" && video.bytes > maxRawBytes) throw new Error(apiText("sourceVideoTooLarge"));
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && url.startsWith("blob:")) {
        try {
            blob = await (await fetch(url)).blob();
        } catch {
            blob = null;
        }
    }
    if (!blob && url && !url.startsWith("blob:")) {
        try {
            blob = await (await fetch(url)).blob();
        } catch {
            blob = null;
        }
    }
    if (!blob) throw new Error(apiText("invalidReferenceVideo"));
    if (blob.size > maxRawBytes) throw new Error(apiText("sourceVideoTooLarge"));
    const dataUrl = await blobToDataUrl(blob);
    if (!dataUrl.startsWith("data:video/") && !dataUrl.startsWith("data:application/octet-stream")) {
        // Some browsers report empty type on stored blobs; force video/mp4 data URL prefix if needed.
        if (dataUrl.startsWith("data:") && dataUrl.includes(";base64,")) {
            const b64 = dataUrl.split(";base64,")[1] || "";
            return `data:${video.type || blob.type || "video/mp4"};base64,${b64}`;
        }
        throw new Error(apiText("invalidReferenceVideo"));
    }
    return dataUrl;
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error(apiText("invalidReferenceAudio"));
    return blobToDataUrl(blob);
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url, mimeType: "video/mp4" };
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiVideoUnsupported"));
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, apiText("seedanceNoTask"));
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse | SeedanceTask) {
    const videoUrl = "video" in payload ? payload.video?.url : undefined;
    return [payload.video_url, payload.result_url, payload.url, videoUrl, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && isPlayableOrContentUrl(url));
}

function isPlayableOrContentUrl(url: string) {
    return isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url) || url.startsWith("data:") || /\/videos\/[^/]+\/content(?:\?|#|$)/i.test(url) || url.startsWith("/v1/videos/") || url.startsWith("/videos/");
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || apiText("videoDownloadFailed"));
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(apiText("localAssetReadFailed")));
        reader.readAsDataURL(blob);
    });
}
