// app-specific guidance comes from the MCP server's instructions. The prompt changes at most daily so the provider's
// prompt cache keeps working; what the user has open goes with each message instead.

export interface PromptNamespace {
  template: string;
  description?: string;
}

export interface PromptSkill {
  name: string;
  description?: string;
  uri: string;
}

export interface PromptInput {
  appName: string;
  serverInstructions?: string;
  appInstructions?: string;
  namespaces: PromptNamespace[];
  skills: PromptSkill[];
  locale?: string;
  now?: Date;
}

export function systemPrompt(input: PromptInput): string {
  const now = input.now ?? new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = [
    `You are the assistant built into ${input.appName}. You act for the signed-in user with their permissions, through the tools below. Be concise and concrete. Answer in the user's language${input.locale ? ` (the app is set to ${input.locale})` : ""}.`,
    `# Working
- Look things up with tools instead of guessing. Use read to read any resource URI; long text comes in chunks, continue with the offset it reports.
- Resources the user attached or has open are listed with their messages as URIs. Read them when they matter, they are not pasted in.
- For tasks with several steps keep a plan with update_plan and finish every step, or mark it dropped.
- Some tools need the user's approval; the app asks them. If the user rejects a call, do not retry it unless asked.
- When a tool fails, read the error and fix the call. Do not repeat a failing call unchanged.
- Mention resources by their URI (for example in backticks) so the user can open them.
- Format answers in Markdown. Keep them short.`,
    `# Today
${now.toLocaleDateString("en-CA", { timeZone: zone })}, ${now.toLocaleDateString("en-GB", { weekday: "long", timeZone: zone })} (time zone ${zone})`,
  ];
  if (input.namespaces.length) {
    parts.push(`# Namespaces (read these URIs)\n${input.namespaces.map((n) => `- ${n.template}${n.description ? `: ${n.description}` : ""}`).join("\n")}`);
  }
  if (input.skills.length) {
    parts.push(
      `# Skills\nInstructions for specific tasks. When a task matches a skill's description, read the skill first and follow it.\n${input.skills.map((s) => `- ${s.name}: ${s.description ?? ""} (${s.uri})`).join("\n")}`,
    );
  }
  if (input.serverInstructions?.trim()) parts.push(`# ${input.appName} instructions\n${input.serverInstructions.trim()}`);
  if (input.appInstructions?.trim()) parts.push(input.appInstructions.trim());
  return parts.join("\n\n");
}
