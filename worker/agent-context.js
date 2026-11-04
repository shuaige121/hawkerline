// Shared, module-private markers for requests that an authenticated AI agent makes through the Worker.
//
// An agent call is authorised once (agent key + scope check in worker/agent.js) and then executed by the
// same admin handlers the owner uses, so every validation, revision check and audit event stays identical.
// The elevated env is an Object.create() child of the real env carrying these Symbols. Symbols cannot be
// produced from a request (headers, body, URL), so no outside caller can reach the admin handlers this way.

export const AGENT_ADMIN = Symbol('hawkerline.agent.admin');
export const AGENT_ACTOR = Symbol('hawkerline.agent.actor');

export function elevatedAgentEnv(env, key) {
  return Object.create(env, {
    [AGENT_ADMIN]: { value: true },
    [AGENT_ACTOR]: { value: `agent:${key.name}` },
  });
}

// Who to record in content events: the agent key's name, or the given default (the owner).
export function actorOf(env, fallback = 'boss') {
  return (env && env[AGENT_ACTOR]) || fallback;
}
