// 拉取模型删除墓碑（zcode-patcher --modelhub「删除持久化」原生子集）。
// 记录每渠道被用户删除的模型 id，再次拉取时不再把它们列为可添加项，防止
// 「删了又被拉回来」。与补丁把 tombstone 写进配置文件不同，这里落在
// localStorage（拉取去重是 UI 行为，不值得动 provider 配置 schema）。

const KEY = "zcode-modelhub-deleted:v1";
/** 单渠道墓碑上限：防无限增长；拉取场景足够大。 */
const MAX_PER_PROVIDER = 200;

type TombstoneMap = Record<string, string[]>;

function loadAll(): TombstoneMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: TombstoneMap = {};
    for (const [providerId, ids] of Object.entries(parsed as TombstoneMap)) {
      if (Array.isArray(ids)) {
        out[providerId] = ids.filter((id): id is string => typeof id === "string");
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveAll(map: TombstoneMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* 静默：墓碑丢失只影响拉取去重 */
  }
}

export function readDeletedModelIds(providerId: string): Set<string> {
  return new Set(loadAll()[providerId] ?? []);
}

export function recordDeletedModel(providerId: string, modelId: string): void {
  const map = loadAll();
  const ids = map[providerId] ?? [];
  const normalized = modelId.trim().toLowerCase();
  if (!normalized || ids.some((id) => id.trim().toLowerCase() === normalized)) return;
  ids.push(modelId);
  map[providerId] = ids.slice(-MAX_PER_PROVIDER);
  saveAll(map);
}
