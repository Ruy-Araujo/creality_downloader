(() => {
  if (window.__crealityCloudExportCollect) return;

  const API = "/api/cxy/v3/model/";
  const errorMessage = (error, fallback = "An unexpected Creality Cloud error occurred.") => {
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error.message === "string" && error.message.trim()) return error.message;
    return fallback;
  };
  const cookie = (name) => document.cookie.split("; ").find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || "";
  const apiHeaders = () => {
    const headers = { "content-type": "application/json", "__CXY_PLATFORM_": "2", "__CXY_APP_ID_": "cxy-gen2", "__CXY_APP_CH_": "nuxt_proxy_pc" };
    const token = cookie("model_token"), uid = cookie("model_user_id");
    if (token) headers.__CXY_TOKEN_ = decodeURIComponent(token);
    if (uid) headers.__CXY_UID_ = decodeURIComponent(uid);
    return headers;
  };
  const post = async (name, body) => {
    const response = await fetch(`${API}${name}`, { method: "POST", credentials: "include", headers: apiHeaders(), body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Creality Cloud responded with ${response.status}.`);
    const data = await response.json();
    if (data.code && data.code !== 0) {
      const error = new Error(apiError(data.code, data.msg));
      error.crealityCode = data.code;
      throw error;
    }
    return data.result;
  };
  const apiError = (code, message) => ({ 4: "Your session has expired. Sign in to Creality Cloud again.", 1000005: "This model must be purchased before its files can be downloaded.", 1000048: "Your Premium download limit has been reached.", 1000042: "Your account does not have permission to download this model.", 1000108: "Creality Cloud temporarily limited downloads from this network. Wait a few minutes before retrying.", 512: "This model or file has been removed." }[code] || message || `Creality Cloud rejected the request (${code}).`);
  const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const pages = async (endpoint, body) => {
    const all = []; let page = 1; let count = Infinity;
    while (all.length < count) {
      const result = await post(endpoint, { ...body, page, pageSize: 100 });
      const list = result?.list || []; all.push(...list); count = Number(result?.count ?? list.length);
      if (!list.length || list.length < 100) break; page += 1;
    }
    return all;
  };
  const deref = (data) => {
    const cache = new Map();
    const read = (value) => {
      if (typeof value === "number") {
        if (cache.has(value)) return cache.get(value);
        const item = data[value];
        if (item === undefined) return value;
        cache.set(value, null);
        const result = read(item); cache.set(value, result); return result;
      }
      if (Array.isArray(value)) return value.length && typeof value[0] === "string" && ["ShallowReactive", "Reactive", "Ref", "ShallowRef"].includes(value[0]) ? read(value[1]) : value.map(read);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, read(item)]));
      return value;
    };
    return read(0);
  };
  const modelFromNuxt = () => {
    const element = document.getElementById("__NUXT_DATA__");
    if (!element?.textContent) throw new Error("The model data has not loaded yet. Wait for the page to finish loading.");
    const root = deref(JSON.parse(element.textContent));
    const entries = Object.entries(root?.data || {});
    const found = entries.find(([key]) => key.startsWith("model-info_"))?.[1]?.result?.groupItem;
    if (!found?.id || !found?.groupName) throw new Error("The model data was not found on this page.");
    return found;
  };
  const gallery = (model) => {
    const primary = Array.isArray(model.pcCovers) && model.pcCovers.length ? [...model.pcCovers, ...(model.editCovers || [])] : (model.editCovers?.length ? model.editCovers : (model.covers || []));
    const seen = new Set();
    return primary.filter((item) => item?.url && !seen.has(item.url) && seen.add(item.url)).map((item) => item.url);
  };
  const descriptionImages = (html) => [...new DOMParser().parseFromString(html || "", "text/html").images].map((image) => image.getAttribute("data-src") || image.src).filter((url) => /^https:\/\//.test(url));
  const makeDownloadPlan = async (model) => {
    const files = await pages("fileListPage", { modelId: model.id });
    const authorId = model.userInfo?.userId ?? model.userId;
    const profiles = (await pages("3mfList", { modelGroupId: model.id, filterType: 11, userId: authorId }))
      .filter((profile) => String(profile.userInfo?.userId) === String(authorId));
    // Creality Cloud rate-limits profile endpoints. Request them one at a time
    // with a short gap, instead of triggering a burst with Promise.all().
    const profileDetails = [];
    let detailRateLimitMessage = "";
    for (const profile of profiles) {
      if (detailRateLimitMessage) {
        profileDetails.push({ profile, detail: null, error: detailRateLimitMessage });
        continue;
      }
      try { profileDetails.push({ profile, detail: await post("3mfDetail", { modelGroupId: model.id, id: profile.id }) }); }
      catch (error) {
        const message = errorMessage(error);
        if (error?.crealityCode === 1000108) detailRateLimitMessage = message;
        profileDetails.push({ profile, detail: null, error: message });
      }
      if (profile !== profiles.at(-1)) await pause(700);
    }
    let downloadFiles = { downloadUrls: [] }, modelDownloadError = "";
    if (files.length) {
      try { downloadFiles = await post("memberDownload", { modelId: model.id, trailType: 2, fileIds: files.map((file) => file.id) }); }
      catch (error) { modelDownloadError = errorMessage(error); }
    }
    const urlById = new Map((downloadFiles.downloadUrls || []).map((item) => [String(item.fileId), item.url]));
    const threeMf = [];
    let rateLimitMessage = "";
    for (const { profile, detail, error: detailError } of profileDetails) {
      const name = detail?.name || `${profile.name || "model"}.3mf`;
      if (rateLimitMessage || detailError) {
        threeMf.push({ id: profile.id, name, url: null, error: rateLimitMessage || detailError, profile });
        continue;
      }
      try {
        threeMf.push({ id: profile.id, name, url: (await post("3mfDownload", { id: profile.id }))?.downloadUrl, profile });
      } catch (error) {
        const message = errorMessage(error);
        if (error?.crealityCode === 1000108) rateLimitMessage = message;
        threeMf.push({ id: profile.id, name, url: null, error: message, profile });
      }
      if (profile !== profileDetails.at(-1)?.profile) await pause(1200);
    }
    return {
      files: files.map((file) => ({ id: file.id, name: `${file.fileName || "file"}${file.fileFormat || ""}`, url: urlById.get(String(file.id)), error: modelDownloadError, kind: "model" })),
      threeMf,
      profileDetails: profileDetails.map(({ profile, detail }) => ({ id: profile.id, name: detail?.name || profile.name, printer: profile.printerName, settings: profile.secondName, size: profile.size })),
    };
  };
  window.__crealityCloudExportCollect = async () => {
    try {
      const model = modelFromNuxt();
      const expectedAlias = location.pathname.split("/").filter(Boolean).at(-1);
      if (model.urlAlias && expectedAlias && model.urlAlias !== expectedAlias) throw new Error("The page changed while the export was starting. Click the extension again.");
      const downloads = await makeDownloadPlan(model);
      return { ok: true, model: { id: model.id, title: model.groupName, descriptionHtml: model.groupDesc || "", author: model.userInfo || {}, categories: model.categories || [], tags: model.tags || [], license: model.license, stats: { downloads: model.downloadCount, likes: model.likeCount, collections: model.collectionCount, comments: model.commentCount, createdAt: model.createTime, updatedAt: model.lastSharedTime }, sourceUrl: location.href, gallery: gallery(model), descriptionImages: descriptionImages(model.groupDesc) }, downloads };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  };
})();
