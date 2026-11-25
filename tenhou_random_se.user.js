// ==UserScript==
// @name         天凤 通用多语音随机 SE (支持 tenhou.net/3 & tenhou.net/4 + GUI)
// @namespace    https://github.com/myouo/tenhou_se
// @version      3.0.0
// @description  同时支持 tenhou.net/3 与 tenhou.net/4！内置悬浮 GUI 输入 se.json 链接，预加载多版本语音到内存，局内零延迟随机播放
// @match        https://tenhou.net/3/*
// @match        https://tenhou.net/4/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
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
    const IS_V4 = location.pathname.startsWith('/4');
    const DEFAULT_SE_JSON_URL = 'https://se.nivalis.is/kazusa.json';
    const STORAGE_KEY_URL = 'tenhou_custom_se_url_v3';
    const STORAGE_KEY_ENABLED = 'tenhou_custom_se_enabled_v3';
    const STORAGE_KEY_PRESETS = 'tenhou_custom_se_presets_v3';
    const STORAGE_KEY_ACTIVE_ID = 'tenhou_custom_se_active_id_v3';
    const VIRTUAL_SLOT_PREFIX = 'https://tenhou-random-se.local/slot/';

    // tenhou.net/4/latest.js 内部音效函数 N(id, arg, delayMs) 的精确数字 ID -> /3/ SE 槽位映射
    const V4_ID_TO_SLOT = {
        107: '9',   // NUKI (拔北)
        112: '40',  // START (开局)
        1029: '41', // YAKUMAN (役满)
        // PON (25=C/M, 26=F)
        127: '25', 128: '25', 1013: '25', 1014: '25',
        132: '26', 1015: '26',
        // KAN (27=C/M, 28=F)
        118: '27', 119: '27', 1016: '27', 1017: '27',
        123: '28', 1018: '28',
        // CHI (29=C/M, 30=F)
        136: '29', 137: '29', 1010: '29', 1011: '29',
        141: '30', 1012: '30',
        // RIICHI (31=C/M, 32=F)
        145: '31', 146: '31', 1019: '31', 1020: '31',
        150: '32', 1021: '32',
        // RON (33=C/M, 34=F)
        154: '33', 155: '33', 1022: '33', 1023: '33',
        159: '34', 1024: '34',
        // TSUMO (35=C/M, 36=F)
        163: '35', 164: '35', 1025: '35', 1026: '35',
        168: '36', 1027: '36',
    };

    const urlAssetCache = new Map();
    const slotPools = new Map();     // slotId -> Array<{ url, arrayBuffer, blobUrl }>
    const decodedPools = new Map();  // slotId -> AudioBuffer[]
    const lastPickIdx = new Map();

    const arrayBufToSlot = new WeakMap();
    const audioBufToSlot = new WeakMap();
    const audioElemToSlot = new WeakMap();
    const blobUrlToSlot = new Map();

    let sharedAudioCtx = null;
    let v4DecodeCounter = 0;
    let loadedCharLabel = '未加载';
    let uiStatusUpdater = null;

    const AudioCtx = win.AudioContext || win.webkitAudioContext;
    const OrigAudioContextProto = AudioCtx ? AudioCtx.prototype : null;

    function getSavedUrl() {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(STORAGE_KEY_URL, DEFAULT_SE_JSON_URL);
            }
            return localStorage.getItem(STORAGE_KEY_URL) || DEFAULT_SE_JSON_URL;
        } catch {
            return DEFAULT_SE_JSON_URL;
        }
    }

    function setSavedUrl(url) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY_URL, url);
            localStorage.setItem(STORAGE_KEY_URL, url);
        } catch {}
    }

    function isEnabled() {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(STORAGE_KEY_ENABLED, true);
            }
            const v = localStorage.getItem(STORAGE_KEY_ENABLED);
            return v === null ? true : v === 'true';
        } catch {
            return true;
        }
    }

    function setEnabled(flag) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY_ENABLED, Boolean(flag));
            localStorage.setItem(STORAGE_KEY_ENABLED, String(Boolean(flag)));
        } catch {}
    }

    function getPresets() {
        const fallback = [{ id: 'kazusa', name: '冬馬かずさ（冬马和纱）', url: DEFAULT_SE_JSON_URL }];
        try {
            let raw = null;
            if (typeof GM_getValue === 'function') {
                raw = GM_getValue(STORAGE_KEY_PRESETS, null);
            }
            if (!raw) raw = localStorage.getItem(STORAGE_KEY_PRESETS);
            const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (Array.isArray(list) && list.length > 0) return list;
        } catch {}
        return fallback;
    }

    function savePresets(list) {
        try {
            const json = JSON.stringify(list);
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY_PRESETS, json);
            localStorage.setItem(STORAGE_KEY_PRESETS, json);
        } catch {}
    }

    function getActivePresetId() {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(STORAGE_KEY_ACTIVE_ID, 'kazusa');
            }
            return localStorage.getItem(STORAGE_KEY_ACTIVE_ID) || 'kazusa';
        } catch {
            return 'kazusa';
        }
    }

    function setActivePresetId(id) {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY_ACTIVE_ID, id);
            localStorage.setItem(STORAGE_KEY_ACTIVE_ID, id);
        } catch {}
    }

    function pickRandomIndex(slotId, len) {
        if (len <= 1) return 0;
        let idx = Math.floor(Math.random() * len);
        if (idx === lastPickIdx.get(slotId)) {
            idx = (idx + 1 + Math.floor(Math.random() * (len - 1))) % len;
        }
        lastPickIdx.set(slotId, idx);
        return idx;
    }

    const origFetch = win.fetch.bind(win);

    async function smartRequest(url, responseType) {
        if (url.startsWith('https://')) {
            try {
                const res = await origFetch(url, { mode: 'cors' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                if (responseType === 'arraybuffer') {
                    return { response: await res.arrayBuffer() };
                }
                return { responseText: await res.text() };
            } catch {
                // 回退到 GM_xmlhttpRequest
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

// 等全部新资源预加载完成后再原子替换，避免加载期间无声

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
                        for (const item of valid) {
                            blobUrlToSlot.set(item.blobUrl, slotId);
                        }
                    }
                })
            );
        }

        await Promise.all(preloadTasks);

        if (sharedAudioCtx) {
            await Promise.all(Array.from(slotPools.keys()).map((id) => ensureDecodedSlot(sharedAudioCtx, id)));
        }

        loadedCharLabel = (data.meta && (data.meta.name || data.meta.id)) || jsonUrl.split('/').pop();
        console.log(`[TenhouRandomSE] 已加载角色「${loadedCharLabel}」，共 ${slotPools.size} 个槽位、${urlAssetCache.size} 条语音`);
        if (uiStatusUpdater) uiStatusUpdater();

        return JSON.stringify({ ver: data.ver || 1.0, se: rewrittenSe });
    }

    async function loadFromUrl(jsonUrl) {
        if (!jsonUrl || !isEnabled()) {
            slotPools.clear();
            decodedPools.clear();
            loadedCharLabel = '已禁用（使用原生 SE）';
            if (uiStatusUpdater) uiStatusUpdater();
            return;
        }
        try {
            const res = await smartRequest(jsonUrl, 'text');
            await processCustomSeJson(jsonUrl, res.responseText);
        } catch (err) {
            loadedCharLabel = '加载失败，请检查链接';
            console.error('[TenhouRandomSE] 加载 se.json 失败:', jsonUrl, err);
            if (uiStatusUpdater) uiStatusUpdater();
        }
    }

    async function ensureDecodedSlot(ctx, slotId) {
        if (!ctx || !OrigAudioContextProto) return;
        const pool = slotPools.get(slotId);
        if (!pool || !pool.length || decodedPools.has(slotId)) return;
        decodedPools.set(slotId, []);
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

    // 页面启动即开始后台预加载当前配置的 se.json（/4/ 必需；/3/ 也会提前缓存好）
    const initialPreloadPromise = loadFromUrl(getSavedUrl());

    // ==========================================
    // Hook fetch & XMLHttpRequest (用于 /3/ 的 se.json 拦截)
    // ==========================================
    function isCandidateSeJsonUrl(url) {
        if (typeof url !== 'string') return false;
        if (url.startsWith(VIRTUAL_SLOT_PREFIX)) return false;
        return /\.json(\?.*)?$/i.test(url) && !url.startsWith('https://tenhou.net/');
    }

    function parseSlotFromVirtualUrl(url) {
        if (typeof url !== 'string' || !url.startsWith(VIRTUAL_SLOT_PREFIX)) return null;
        return decodeURIComponent(url.slice(VIRTUAL_SLOT_PREFIX.length).replace(/\.mp3$/i, ''));
    }

    win.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const slotId = parseSlotFromVirtualUrl(url);
        if (slotId) {
            await initialPreloadPromise;
            const pool = slotPools.get(slotId);
            if (pool && pool.length) {
                const cloneBuf = pool[0].arrayBuffer.slice(0);
                arrayBufToSlot.set(cloneBuf, slotId);
                const resp = new Response(cloneBuf, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
                const origAB = resp.arrayBuffer.bind(resp);
                resp.arrayBuffer = async () => {
                    const ab = await origAB();
                    arrayBufToSlot.set(ab, slotId);
                    return ab;
                };
                return resp;
            }
        }
        if (!IS_V4 && isEnabled() && isCandidateSeJsonUrl(url)) {
            try {
                const res = await smartRequest(url, 'text');
                const rewritten = await processCustomSeJson(url, res.responseText);
                return new Response(rewritten, { status: 200, headers: { 'Content-Type': 'application/json' } });
            } catch (e) {
                console.warn('[TenhouRandomSE] fetch 拦截 se.json 失败，回退原生:', url, e);
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
                initialPreloadPromise.then(() => {
                    const pool = slotPools.get(slotId);
                    const buf = pool && pool.length ? pool[0].arrayBuffer.slice(0) : new ArrayBuffer(0);
                    arrayBufToSlot.set(buf, slotId);
                    Object.defineProperties(xhr, {
                        readyState: { get: () => 4 },
                        status: { get: () => 200 },
                        statusText: { get: () => 'OK' },
                        response: { get: () => buf },
                    });
                    xhr.dispatchEvent(new Event('readystatechange'));
                    xhr.dispatchEvent(new Event('load'));
                });
                return;
            }
            if (!IS_V4 && isEnabled() && isCandidateSeJsonUrl(reqUrl)) {
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
                    .catch(() => origSend.call(xhr, body));
                return;
            }
            return origSend.call(xhr, body);
        };
        return xhr;
    };

    // ==========================================
    // Hook Web Audio API (兼容 /3/ 与 /4/ 核心引擎)
    // ==========================================
    if (OrigAudioContextProto) {
        const origDecode = OrigAudioContextProto.decodeAudioData;
        OrigAudioContextProto.decodeAudioData = function (audioData, successCb, errorCb) {
            sharedAudioCtx = this;
            let slotId = arrayBufToSlot.get(audioData);

// /4/ 使用下方 win.N 直接拦截，不再依赖 decodeAudioData 序号猜测

            if (slotId) {
                initialPreloadPromise.then(() => ensureDecodedSlot(this, slotId));
            }

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
        const bufDesc = Object.getOwnPropertyDescriptor(srcProto, 'buffer');
        if (bufDesc && bufDesc.set) {
            Object.defineProperty(srcProto, 'buffer', {
                configurable: true,
                enumerable: bufDesc.enumerable,
                get: bufDesc.get,
                set(val) {
                    try {
                        if (isEnabled()) {
                            const slotId = val && audioBufToSlot.get(val);
                            const pool = slotId && decodedPools.get(slotId);
                            if (pool && pool.length > 0) {
                                const idx = pickRandomIndex(slotId, pool.length);
                                val = pool[idx];
                                console.log(`[TenhouRandomSE] WebAudio 替换 slot[${slotId}] -> #${idx + 1}`);
                            }
                        }
                    } catch (e) {
                        console.warn('[TenhouRandomSE] WebAudio 替换异常:', e);
                    }
                    return bufDesc.set.call(this, val);
                },
            });
        }
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
            if (isEnabled()) {
                const curSrc = this.currentSrc || this.src || '';
                const slotId = audioElemToSlot.get(this) || parseSlotFromVirtualUrl(curSrc) || blobUrlToSlot.get(curSrc);
                if (slotId) {
                    audioElemToSlot.set(this, slotId);
                    const pool = slotPools.get(slotId);
                    if (pool && pool.length > 1) {
                        const idx = pickRandomIndex(slotId, pool.length);
                        this.src = pool[idx].blobUrl;
                        this.load();
                    }
                }
            }
        } catch (e) {
            console.warn('[TenhouRandomSE] Audio.play 异常:', e);
        }
        return origPlay.apply(this, args);
    };

    // ==========================================
    // 悬浮 GUI 设置窗口（支持 /4/ 与 /3/）
    // ==========================================
    function mountGui() {
        if (document.getElementById('tenhou-se-gui-root')) return;

        const root = document.createElement('div');
        root.id = 'tenhou-se-gui-root';
        root.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;font-size:13px;line-height:1.4;';

        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = '🎵 自定义 SE';
        toggleBtn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:#ffffff;color:#0f172a;border:1px solid #cbd5e1;border-radius:999px;padding:8px 14px;cursor:pointer;box-shadow:0 6px 20px rgba(15,23,42,.16),0 1px 3px rgba(15,23,42,.08);font-weight:600;font-size:13px;letter-spacing:.2px;';

        const panel = document.createElement('div');
        panel.style.cssText = 'display:none;width:348px;background:#ffffff;color:#0f172a;border:1px solid #e2e8f0;border-radius:14px;padding:16px;margin-bottom:10px;box-shadow:0 18px 40px rgba(15,23,42,.22),0 2px 8px rgba(15,23,42,.08);';

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;margin-bottom:12px;border-bottom:1px solid #f1f5f9;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block;"></span>
                    <strong style="font-size:14px;color:#0f172a;font-weight:700;">天凤 SE 替换</strong>
                    <span style="font-size:11px;color:#475569;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:1px 7px;font-weight:600;">${IS_V4 ? '/4/ 4K版' : '/3/ 网页版'}</span>
                </div>
                <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;color:#334155;font-weight:600;">
                    <input id="th-se-enable" type="checkbox" ${isEnabled() ? 'checked' : ''} style="accent-color:#2563eb;cursor:pointer;" /> 启用
                </label>
            </div>

            <div style="margin-bottom:5px;font-size:12px;color:#475569;font-weight:600;">已保存配置（选择即切换）</div>
            <div style="display:flex;gap:6px;margin-bottom:10px;">
                <select id="th-se-preset" style="flex:1;padding:7px 8px;border-radius:8px;border:1px solid #cbd5e1;background:#ffffff;color:#0f172a;font-size:12px;font-weight:500;outline:none;"></select>
                <button id="th-se-del" title="删除当前配置" style="background:#fff1f2;color:#be123c;border:1px solid #fecdd3;border-radius:8px;padding:7px 10px;cursor:pointer;font-weight:600;font-size:12px;">删除</button>
            </div>

            <div style="margin-bottom:5px;font-size:12px;color:#475569;font-weight:600;">配置名称 & JSON 链接</div>
            <input id="th-se-name" type="text" placeholder="配置名称（如：冬马和纱 / 雪菜）"
                style="width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;margin-bottom:6px;font-size:12px;outline:none;" />
            <input id="th-se-url" type="text" value="${getSavedUrl().replace(/"/g, '&quot;')}"
                placeholder="https://se.nivalis.is/kazusa.json"
                style="width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;margin-bottom:10px;font-size:12px;outline:none;" />

            <div style="display:flex;gap:8px;margin-bottom:12px;">
                <button id="th-se-save" style="flex:1;background:#2563eb;color:#ffffff;border:none;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600;font-size:12px;box-shadow:0 2px 6px rgba(37,99,235,.28);">保存并应用</button>
                <button id="th-se-apply" style="background:#f1f5f9;color:#334155;border:1px solid #cbd5e1;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600;font-size:12px;">仅临时加载</button>
            </div>

            <div id="th-se-status" style="font-size:12px;color:#0369a1;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:7px 10px;margin-bottom:12px;word-break:break-all;font-weight:500;"></div>

            <div style="font-size:11px;color:#64748b;margin-bottom:6px;font-weight:600;">点击试听（每次随机切换）</div>
            <div id="th-se-tests" style="display:flex;flex-wrap:wrap;gap:6px;">
                ${[
                    ['29', '吃'],
                    ['25', '碰'],
                    ['27', '杠'],
                    ['31', '立直'],
                    ['33', '荣'],
                    ['35', '自摸'],
                    ['9', '拔北'],
                ].map(([id, label]) => `<button data-slot="${id}" style="background:#ffffff;color:#1e293b;border:1px solid #cbd5e1;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;font-weight:600;box-shadow:0 1px 2px rgba(15,23,42,.05);">${label}</button>`).join('')}
            </div>
        `;

        root.appendChild(panel);
        root.appendChild(toggleBtn);
        document.body.appendChild(root);

        const presetSel = panel.querySelector('#th-se-preset');
        const nameInput = panel.querySelector('#th-se-name');
        const urlInput = panel.querySelector('#th-se-url');
        const enableChk = panel.querySelector('#th-se-enable');
        const statusEl = panel.querySelector('#th-se-status');

        function renderPresets() {
            const presets = getPresets();
            const activeId = getActivePresetId();
            presetSel.innerHTML = '';
            for (const item of presets) {
                const opt = document.createElement('option');
                opt.value = item.id;
                opt.textContent = item.name;
                if (item.id === activeId) opt.selected = true;
                presetSel.appendChild(opt);
            }
            const active = presets.find((x) => x.id === presetSel.value) || presets[0];
            if (active) {
                nameInput.value = active.name;
                urlInput.value = active.url;
            }
        }

        renderPresets();

        uiStatusUpdater = () => {
            statusEl.textContent = `状态：${loadedCharLabel}（${slotPools.size} 槽位）`;
        };
        uiStatusUpdater();

        toggleBtn.addEventListener('click', () => {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        });

        presetSel.addEventListener('change', async () => {
            const presets = getPresets();
            const picked = presets.find((x) => x.id === presetSel.value);
            if (!picked) return;
            setActivePresetId(picked.id);
            setSavedUrl(picked.url);
            nameInput.value = picked.name;
            urlInput.value = picked.url;
            setEnabled(true);
            enableChk.checked = true;
            statusEl.textContent = `正在切换至「${picked.name}」...`;
            await loadFromUrl(picked.url);
        });

        panel.querySelector('#th-se-save').addEventListener('click', async () => {
            const u = urlInput.value.trim();
            if (!u) return;
            const n = nameInput.value.trim() || u.split('/').pop().replace(/\.json$/i, '') || '自定义配置';
            const presets = getPresets();
            const existing = presets.find((x) => x.name === n || x.url === u);
            let targetId;
            if (existing) {
                existing.name = n;
                existing.url = u;
                targetId = existing.id;
            } else {
                targetId = 'p_' + Date.now();
                presets.push({ id: targetId, name: n, url: u });
            }
            savePresets(presets);
            setActivePresetId(targetId);
            setSavedUrl(u);
            renderPresets();
            setEnabled(true);
            enableChk.checked = true;
            statusEl.textContent = `已保存并加载「${n}」...`;
            await loadFromUrl(u);
        });

        panel.querySelector('#th-se-del').addEventListener('click', async () => {
            let presets = getPresets();
            const delId = presetSel.value;
            presets = presets.filter((x) => x.id !== delId);
            if (presets.length === 0) {
                presets = [{ id: 'kazusa', name: '冬馬かずさ（冬马和纱）', url: DEFAULT_SE_JSON_URL }];
            }
            savePresets(presets);
            setActivePresetId(presets[0].id);
            setSavedUrl(presets[0].url);
            renderPresets();
            statusEl.textContent = `已切换至「${presets[0].name}」...`;
            await loadFromUrl(presets[0].url);
        });

        enableChk.addEventListener('change', async () => {
            setEnabled(enableChk.checked);
            await loadFromUrl(urlInput.value.trim());
        });

        panel.querySelector('#th-se-apply').addEventListener('click', async () => {
            const u = urlInput.value.trim();
            setSavedUrl(u);
            setEnabled(true);
            enableChk.checked = true;
            statusEl.textContent = '正在加载并预解码...';
            await loadFromUrl(u);
        });

        panel.querySelectorAll('#th-se-tests button').forEach((btn) => {
            btn.addEventListener('click', () => {
                win.__tenhouRandomSE.test(btn.getAttribute('data-slot'));
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountGui);
    } else {
        mountGui();
    }

    // ==========================================
    // tenhou.net/4 专用：在 /4/latest.js 加载时注入 N(c,m,b) 拦截器（因为 latest.js 在 IIFE 内部）
    // ==========================================
    if (IS_V4) {
        let v4GainNode = null;

        win.__tenhouV4_onN = function (id, arg, delayMs, gainNode) {
            if (gainNode) v4GainNode = gainNode;
            if (!isEnabled()) return false;
            const slotId = V4_ID_TO_SLOT[id];
            if (!slotId) return false;

            const dPool = decodedPools.get(slotId);
            const rPool = slotPools.get(slotId);
            if ((!dPool || dPool.length === 0) && (!rPool || rPool.length === 0)) {
                return false; // 尚未就绪时回退原生音效，绝不静音
            }

            const playCustom = () => {
                if (sharedAudioCtx && dPool && dPool.length > 0) {
                    try {
                        const idx = pickRandomIndex(slotId, dPool.length);
                        const bs = sharedAudioCtx.createBufferSource();
                        bs.buffer = dPool[idx];
                        bs.connect(v4GainNode || sharedAudioCtx.destination);
                        const when = delayMs && delayMs > 0 ? sharedAudioCtx.currentTime + delayMs / 1000 : 0;
                        bs.start(when);
                        console.log(`[TenhouRandomSE] /4/ WebAudio 替换 id=${id} -> slot[${slotId}] #${idx + 1}`);
                        return;
                    } catch (e) {
                        console.warn('[TenhouRandomSE] /4/ WebAudio 播放失败，回退 Audio:', e);
                    }
                }
                if (rPool && rPool.length > 0) {
                    const idx = pickRandomIndex(slotId, rPool.length);
                    const a = new OrigAudio(rPool[idx].blobUrl);
                    if (v4GainNode && v4GainNode.gain) a.volume = Math.max(0, Math.min(1, v4GainNode.gain.value));
                    const run = () => a.play().catch(() => {});
                    if (delayMs && delayMs > 0) setTimeout(run, delayMs);
                    else run();
                    console.log(`[TenhouRandomSE] /4/ Audio 替换 id=${id} -> slot[${slotId}] #${idx + 1}`);
                }
            };

            if (sharedAudioCtx && dPool && dPool.length > 0) {
                playCustom();
            } else if (delayMs && delayMs > 0) {
                setTimeout(playCustom, delayMs);
            } else {
                playCustom();
            }

            // 组合音效保留天凤原生拍牌/特效声（113=鸣牌拍桌, 114=和牌重音）
            if (typeof win.__tenhouV4_origN === 'function') {
                if (id >= 1010 && id <= 1018) win.__tenhouV4_origN(113, arg, delayMs);
                else if (id >= 1022 && id <= 1027) win.__tenhouV4_origN(114, arg, delayMs);
            }
            return true;
        };

        const origAppendChild = win.Node.prototype.appendChild;
        win.Node.prototype.appendChild = function (node) {
            if (
                node &&
                node.tagName === 'SCRIPT' &&
                typeof node.src === 'string' &&
                /\/4\/latest\.js(\?.*)?$/i.test(node.src) &&
                !node.__tenhouPatched
            ) {
                const targetSrc = node.src;
                const onloadCb = node.onload;
                origFetch(targetSrc)
                    .then((r) => r.text())
                    .then((code) => {
                        const needle = 'N=function(c,m,b){';
                        if (!code.includes(needle)) {
                            console.warn('[TenhouRandomSE] 未找到 /4/latest.js 注入点，回退原脚本');
                            node.__tenhouPatched = true;
                            origAppendChild.call(this, node);
                            return;
                        }
                        const patched = code.replace(
                            needle,
                            'N=window.__tenhouV4_origN=function(c,m,b){if(window.__tenhouV4_onN&&window.__tenhouV4_onN(c,m,b,d))return;'
                        );
                        const inlineScript = document.createElement('script');
                        inlineScript.__tenhouPatched = true;
                        inlineScript.textContent = patched;
                        origAppendChild.call(this, inlineScript);
                        console.log('[TenhouRandomSE] 已成功注入 tenhou.net/4/latest.js 音效拦截器');
                        if (typeof onloadCb === 'function') onloadCb.call(inlineScript);
                    })
                    .catch((err) => {
                        console.warn('[TenhouRandomSE] 拉取 /4/latest.js 失败，回退原脚本:', err);
                        node.__tenhouPatched = true;
                        origAppendChild.call(this, node);
                    });
                return node;
            }
            return origAppendChild.call(this, node);
        };
    }

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
            console.log(`[TenhouRandomSE] 试听 slot[${slotId}] -> #${idx + 1} (${pool[idx].url})`);
        },
    };
})();
