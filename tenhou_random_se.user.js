// ==UserScript==
// @name         天凤 通用多语音随机 SE (支持任意角色 se.json)
// @namespace    https://github.com/pojelo199/tenhou-random-se
// @version      2.0.0
// @description  自动识别天凤 SE 设置中填入的任意角色 se.json（支持 urls 数组），预加载到内存，局内每次触发零延迟随机播放
// @match        https://tenhou.net/3/*
// @match        https://tenhou.net/4/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      se.nivalis.is
// @connect      *.nivalis.is
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // 虚拟占位域：当你在天凤 SE 填入自己的 se.json（支持相对路径或完整 https 路径）时，
    // 脚本会自动拉取并解析其中的 urls 数组，并把返回给天凤的 url 改写为下面这个虚拟槽位前缀。
    const VIRTUAL_SLOT_PREFIX = 'https://tenhou-random-se.local/slot/';

    // 若同一角色男/女槽位（如 25/26）共用同一组音频，按 URL 去重缓存，避免重复下载
    const urlAssetCache = new Map(); // resolvedUrl -> Promise<{ arrayBuffer, blobUrl }>
    const slotPools = new Map();     // slotId -> Array<{ url, arrayBuffer, blobUrl }>
    const decodedPools = new Map();  // slotId -> AudioBuffer[]
    const lastPickIdx = new Map();   // slotId -> number

    const arrayBufToSlot = new WeakMap();
    const audioBufToSlot = new WeakMap();
    const audioElemToSlot = new WeakMap();
    const blobUrlToSlot = new Map();

    const AudioCtx = win.AudioContext || win.webkitAudioContext;
    const OrigAudioContextProto = AudioCtx ? AudioCtx.prototype : null;

    function pickRandomIndex(slotId, len) {
        if (len <= 1) return 0;
        let idx = Math.floor(Math.random() * len);
        if (idx === lastPickIdx.get(slotId)) {
            idx = (idx + 1 + Math.floor(Math.random() * (len - 1))) % len;
        }
        lastPickIdx.set(slotId, idx);
        return idx;
    }

    async function smartRequest(url, responseType) {
        // 优先走原生 fetch（se.nivalis.is 已配置 Access-Control-Allow-Origin: *，不会触发油猴跨域弹窗）
        if (url.startsWith('https://')) {
            try {
                const res = await origFetch(url, { mode: 'cors' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                if (responseType === 'arraybuffer') {
                    return { response: await res.arrayBuffer() };
                }
                return { responseText: await res.text() };
            } catch {
                // 若目标站点未开 CORS，再回退到 GM_xmlhttpRequest
            }
        }
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        resolve(res);
                    } else {
                        reject(new Error(`HTTP ${res.status} for ${url}`));
                    }
                },
                onerror: (err) => reject(err),
            });
        });
    }

    function loadAudioAsset(resolvedUrl) {
        if (urlAssetCache.has(resolvedUrl)) return urlAssetCache.get(resolvedUrl);
        const p = smartRequest(resolvedUrl, 'arraybuffer').then((res) => {
            const arrayBuffer = res.response;
            const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
            const blobUrl = URL.createObjectURL(blob);
            return { url: resolvedUrl, arrayBuffer, blobUrl };
        });
        urlAssetCache.set(resolvedUrl, p);
        return p;
    }

    function isCandidateSeJsonUrl(url) {
        if (typeof url !== 'string') return false;
        if (url.startsWith(VIRTUAL_SLOT_PREFIX)) return false;
        // 拦截外部或本地的 .json 配置文件（排除 tenhou.net 自身内置静态资源）
        return /\.json(\?.*)?$/i.test(url) && !url.startsWith('https://tenhou.net/');
    }

    function resolveAudioUrl(rawUrl, jsonUrl) {
        try {
            return new URL(rawUrl, jsonUrl).href;
        } catch {
            return rawUrl;
        }
    }

    async function processCustomSeJson(jsonUrl, rawText) {
        const data = JSON.parse(rawText);
        if (!data || typeof data !== 'object' || !data.se || typeof data.se !== 'object') {
            return rawText;
        }

        const baseForRel = (data.meta && data.meta.base)
            ? resolveAudioUrl(data.meta.base, jsonUrl)
            : jsonUrl;

        const rewrittenSe = {};
        const preloadTasks = [];

        for (const [slotId, entry] of Object.entries(data.se)) {
            if (!entry || typeof entry !== 'object') continue;
            const list = [];
            if (Array.isArray(entry.urls)) {
                for (const u of entry.urls) {
                    if (typeof u === 'string' && u.trim()) list.push(resolveAudioUrl(u.trim(), baseForRel));
                }
            }
            if (list.length === 0 && typeof entry.url === 'string' && entry.url.trim()) {
                list.push(resolveAudioUrl(entry.url.trim(), baseForRel));
            }
            if (list.length === 0) continue;

            // 将该槽位暴露给天凤为稳定的虚拟 URL，后续播放时再随机替换
            rewrittenSe[slotId] = { url: `${VIRTUAL_SLOT_PREFIX}${encodeURIComponent(slotId)}.mp3` };

            preloadTasks.push(
                Promise.all(
                    list.map((u) =>
                        loadAudioAsset(u).catch((err) => {
                            console.warn(`[TenhouRandomSE] 预加载失败 (${slotId}):`, u, err);
                            return null;
                        })
                    )
                ).then((assets) => {
                    const valid = assets.filter(Boolean);
                    if (valid.length > 0) {
                        slotPools.set(slotId, valid);
                        decodedPools.delete(slotId);
                        for (const item of valid) {
                            blobUrlToSlot.set(item.blobUrl, slotId);
                        }
                    }
                })
            );
        }

        await Promise.all(preloadTasks);
        const charName = (data.meta && (data.meta.name || data.meta.id)) || jsonUrl;
        const totalFiles = urlAssetCache.size;
        console.log(`[TenhouRandomSE] 已加载角色「${charName}」，共 ${slotPools.size} 个槽位、${totalFiles} 条独立语音到内存`);

        return JSON.stringify({ ver: data.ver || 1.0, se: rewrittenSe });
    }

    async function ensureDecodedSlot(ctx, slotId) {
        if (!ctx || !OrigAudioContextProto) return;
        const pool = slotPools.get(slotId);
        if (!pool || !pool.length || decodedPools.has(slotId)) return;
        decodedPools.set(slotId, []); // 占位防重入
        const origDecode = OrigAudioContextProto.decodeAudioData;
        const decodedList = [];
        for (const item of pool) {
            try {
                const decoded = await origDecode.call(ctx, item.arrayBuffer.slice(0));
                audioBufToSlot.set(decoded, slotId);
                decodedList.push(decoded);
            } catch (e) {
                console.warn('[TenhouRandomSE] WebAudio 解码失败:', slotId, item.url, e);
            }
        }
        if (decodedList.length > 0) {
            decodedPools.set(slotId, decodedList);
        } else {
            decodedPools.delete(slotId);
        }
    }

    function parseSlotFromVirtualUrl(url) {
        if (typeof url !== 'string' || !url.startsWith(VIRTUAL_SLOT_PREFIX)) return null;
        return decodeURIComponent(url.slice(VIRTUAL_SLOT_PREFIX.length).replace(/\.mp3$/i, ''));
    }

    // ==========================================
    // Hook fetch & XMLHttpRequest
    // ==========================================
    const origFetch = win.fetch.bind(win);
    win.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const slotId = parseSlotFromVirtualUrl(url);
        if (slotId) {
            const pool = slotPools.get(slotId);
            if (pool && pool.length) {
                const cloneBuf = pool[0].arrayBuffer.slice(0);
                arrayBufToSlot.set(cloneBuf, slotId);
                const resp = new Response(cloneBuf, {
                    status: 200,
                    headers: { 'Content-Type': 'audio/mpeg' },
                });
                const origAB = resp.arrayBuffer.bind(resp);
                resp.arrayBuffer = async () => {
                    const ab = await origAB();
                    arrayBufToSlot.set(ab, slotId);
                    return ab;
                };
                return resp;
            }
        }
        if (isCandidateSeJsonUrl(url)) {
            try {
                const res = await smartRequest(url, 'text');
                const rewritten = await processCustomSeJson(url, res.responseText);
                return new Response(rewritten, {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (e) {
                console.warn('[TenhouRandomSE] GM 获取 se.json 失败，回退原生 fetch:', url, e);
            }
        }
        return origFetch(input, init);
    };

    const OrigXHR = win.XMLHttpRequest;
    win.XMLHttpRequest = function () {
        const xhr = new OrigXHR();
        let reqUrl = '';
        const origOpen = xhr.open;
        const origSend = xhr.send;

        xhr.open = function (method, url, ...rest) {
            reqUrl = String(url || '');
            return origOpen.call(this, method, url, ...rest);
        };

        xhr.send = function (body) {
            const slotId = parseSlotFromVirtualUrl(reqUrl);
            if (slotId) {
                const pool = slotPools.get(slotId);
                const buf = pool && pool.length ? pool[0].arrayBuffer.slice(0) : new ArrayBuffer(0);
                arrayBufToSlot.set(buf, slotId);
                setTimeout(() => {
                    Object.defineProperties(xhr, {
                        readyState: { get: () => 4 },
                        status: { get: () => 200 },
                        statusText: { get: () => 'OK' },
                        response: { get: () => buf },
                    });
                    xhr.dispatchEvent(new Event('readystatechange'));
                    xhr.dispatchEvent(new Event('load'));
                }, 0);
                return;
            }
            if (isCandidateSeJsonUrl(reqUrl)) {
                smartRequest(reqUrl, 'text')
                    .then((res) => processCustomSeJson(reqUrl, res.responseText))
                    .then((rewritten) => {
                        Object.defineProperties(xhr, {
                            readyState: { get: () => 4 },
                            status: { get: () => 200 },
                            statusText: { get: () => 'OK' },
                            responseText: { get: () => rewritten },
                            response: { get: () => rewritten },
                        });
                        xhr.dispatchEvent(new Event('readystatechange'));
                        xhr.dispatchEvent(new Event('load'));
                    })
                    .catch((e) => {
                        console.warn('[TenhouRandomSE] XHR 拦截 se.json 失败，回退原生请求:', reqUrl, e);
                        origSend.call(xhr, body);
                    });
                return;
            }
            return origSend.call(this, body);
        };
        return xhr;
    };

    // ==========================================
    // Hook Web Audio API & HTMLAudioElement
    // ==========================================
    if (OrigAudioContextProto) {
        const origDecode = OrigAudioContextProto.decodeAudioData;
        OrigAudioContextProto.decodeAudioData = function (audioData, successCb, errorCb) {
            const slotId = arrayBufToSlot.get(audioData);
            if (slotId) ensureDecodedSlot(this, slotId);

            if (typeof successCb === 'function') {
                return origDecode.call(
                    this,
                    audioData,
                    (decoded) => {
                        if (slotId && decoded) audioBufToSlot.set(decoded, slotId);
                        successCb(decoded);
                    },
                    errorCb
                );
            }
            const p = origDecode.call(this, audioData);
            if (p && typeof p.then === 'function') {
                return p.then((decoded) => {
                    if (slotId && decoded) audioBufToSlot.set(decoded, slotId);
                    return decoded;
                });
            }
            return p;
        };
    }

    if (win.AudioBufferSourceNode) {
        const srcProto = win.AudioBufferSourceNode.prototype;
        const origStart = srcProto.start;
        srcProto.start = function (...args) {
            try {
                const slotId = this.buffer && audioBufToSlot.get(this.buffer);
                const pool = slotId && decodedPools.get(slotId);
                if (pool && pool.length > 1) {
                    const idx = pickRandomIndex(slotId, pool.length);
                    this.buffer = pool[idx];
                    console.log(`[TenhouRandomSE] WebAudio 随机 slot[${slotId}] -> #${idx + 1}`);
                }
            } catch (e) {
                console.warn('[TenhouRandomSE] WebAudio 随机切换异常:', e);
            }
            return origStart.apply(this, args);
        };
    }

    const OrigAudio = win.Audio;
    win.Audio = function (src) {
        const slotId = parseSlotFromVirtualUrl(src);
        if (slotId) {
            const audio = new OrigAudio();
            audioElemToSlot.set(audio, slotId);
            const pool = slotPools.get(slotId);
            if (pool && pool.length) {
                audio.src = pool[pickRandomIndex(slotId, pool.length)].blobUrl;
            }
            return audio;
        }
        return new OrigAudio(src);
    };
    win.Audio.prototype = OrigAudio.prototype;

    const origPlay = win.HTMLMediaElement.prototype.play;
    win.HTMLMediaElement.prototype.play = function (...args) {
        try {
            const curSrc = this.currentSrc || this.src || '';
            const slotId = audioElemToSlot.get(this) || parseSlotFromVirtualUrl(curSrc) || blobUrlToSlot.get(curSrc);
            if (slotId) {
                audioElemToSlot.set(this, slotId);
                const pool = slotPools.get(slotId);
                if (pool && pool.length > 1) {
                    const idx = pickRandomIndex(slotId, pool.length);
                    this.src = pool[idx].blobUrl;
                    this.load();
                    console.log(`[TenhouRandomSE] Audio.play 随机 slot[${slotId}] -> #${idx + 1}`);
                }
            }
        } catch (e) {
            console.warn('[TenhouRandomSE] Audio.play 随机切换异常:', e);
        }
        return origPlay.apply(this, args);
    };

    // ==========================================
    // 控制台调试助手
    // ==========================================
    win.__tenhouRandomSE = {
        status() {
            const out = {};
            for (const [slotId, pool] of slotPools.entries()) {
                out[slotId] = {
                    variants: pool.length,
                    decoded: (decodedPools.get(slotId) || []).length,
                    files: pool.map((x) => x.url.split('/').pop()),
                };
            }
            console.table(out);
            return out;
        },
        async test(slotId = '27') {
            const pool = slotPools.get(String(slotId));
            if (!pool || !pool.length) {
                console.warn('[TenhouRandomSE] 未找到槽位:', slotId);
                return;
            }
            const idx = pickRandomIndex(String(slotId), pool.length);
            const a = new OrigAudio(pool[idx].blobUrl);
            await a.play();
            console.log(`[TenhouRandomSE] 测试播放 slot[${slotId}] -> #${idx + 1} (${pool[idx].url})`);
        },
    };
})();
