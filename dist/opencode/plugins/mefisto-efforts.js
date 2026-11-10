// GENERADO por src/published/scripts/adapters/adapter-opencode.sh desde src/published/agents/*.md. No editar a mano.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const agents = [{"id":"apim-gateway-scaffolder","profile":"balanced","effort":"light"},{"id":"bug-investigator","profile":"deep","effort":"thorough"},{"id":"domain-scaffolder","profile":"balanced","effort":"light"},{"id":"historiador","profile":"balanced","effort":"light"},{"id":"implementer","profile":"balanced","effort":"standard"},{"id":"infra-base-scaffolder","profile":"balanced","effort":"light"},{"id":"infra-bootstrap","profile":"fast","effort":"light"},{"id":"infra-reviewer","profile":"deep","effort":"standard"},{"id":"infra-writer","profile":"balanced","effort":"light"},{"id":"mcp-scaffolder","profile":"balanced","effort":"light"},{"id":"planner","profile":"deep","effort":"thorough"},{"id":"pr-sync","profile":"balanced","effort":"light"},{"id":"projection-implementer","profile":"balanced","effort":"standard"},{"id":"projection-test-writer","profile":"balanced","effort":"light"},{"id":"projections-scaffolder","profile":"balanced","effort":"light"},{"id":"reviewer","profile":"deep","effort":"thorough"},{"id":"smoke-test-writer","profile":"balanced","effort":"light"},{"id":"test-writer","profile":"balanced","effort":"light"},{"id":"tooling-investigator","profile":"deep","effort":"thorough"},{"id":"tooling-reviewer","profile":"deep","effort":"standard"},{"id":"tooling-writer","profile":"balanced","effort":"light"},{"id":"workos-identity-scaffolder","profile":"balanced","effort":"light"}];
const natives = {"quick":"low","light":"medium","standard":"high","thorough":"xhigh","exhaustive":"max"};
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const pick = (object, key) => (isObject(object) && owns(object, key) ? object[key] : undefined);
const log = async (client, event, agent) => {
  try { await client?.app?.log?.({ body: { service: "mefisto", level: "warn", message: event, extra: { event, agent } } }); } catch { /* failure: continue */ }
};
const validTextMap = (value) => value === undefined || (isObject(value) && Object.values(value).every(isText));
const loadSection = (root) => {
  let text;
  try { text = readFileSync(join(root, ".mefisto", "models.json"), "utf8"); } catch (error) { return error?.code === "ENOENT" ? {} : null; }
  try {
    const mapping = JSON.parse(text);
    if (!isObject(mapping)) return null;
    const section = mapping.opencode === undefined ? {} : mapping.opencode;
    if (!isObject(section)) return null;
    const efforts = section.efforts;
    if (!validTextMap(section.profiles) || !validTextMap(section.agents)) return null;
    if (efforts !== undefined && (!isObject(efforts) || !validTextMap(efforts.agents) || !validTextMap(efforts.levels))) return null;
    return section;
  } catch { return null; }
};

export default async function mefistoEfforts({ client, worktree, directory } = {}) {
  return {
    config: async (config) => {
      try {
        if (!isObject(config)) throw new Error("invalid_config");
        const section = loadSection(worktree || directory || process.cwd());
        if (section === null) { await log(client, "efforts_mapping_invalid"); return; }
        if (config.agent !== undefined && !isObject(config.agent)) throw new Error("invalid_agent");
        for (const { id, profile, effort } of agents) {
          const model = pick(section.agents, id) ?? pick(section.profiles, profile);
          if (model === undefined) continue;
          const level = pick(section.efforts?.agents, id) ?? effort;
          if (!owns(natives, level)) { await log(client, "efforts_level_invalid", id); continue; }
          const variant = pick(section.efforts?.levels, level) ?? natives[level];
          const actual = pick(config.agent, id);
          if (isObject(actual) && (actual.model !== undefined || actual.variant !== undefined)) { await log(client, "efforts_config_conflict", id); continue; }
          if (config.agent === undefined) config.agent = {};
          config.agent[id] = { ...(isObject(actual) ? actual : {}), model, variant };
        }
      } catch { await log(client, "efforts_config_hook_failed"); }
    },
  };
}
