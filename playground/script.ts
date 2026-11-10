import type { FakeTurn, ResponsesInputItem } from "../test/fake-provider";
import { lastUser, toolOutputs } from "../test/fake-provider";

function isUserMessage(item: ResponsesInputItem): boolean {
  if (item.role !== "user") return false;
  const text = lastUser([item]);
  return !text.startsWith("Visual data") && !text.startsWith("<system-reminder>");
}

function sinceLastUser(input: ResponsesInputItem[]): ResponsesInputItem[] {
  return input.slice(input.map(isUserMessage).lastIndexOf(true) + 1);
}

function imagesSeen(items: ResponsesInputItem[]): number {
  return items.reduce((n, i) => n + (Array.isArray(i.content) ? i.content.filter((c: { type?: string }) => c.type === "input_image").length : 0), 0);
}

export function playgroundScript(input: ResponsesInputItem[]): FakeTurn {
  const userItem = [...input].reverse().find(isUserMessage);
  const user = (userItem ? lastUser([userItem]) : "").split("\n\n[Attached:")[0]!.toLowerCase();
  const recent = sinceLastUser(input);
  const results = toolOutputs(recent);
  const step = results.length;

  if (user.includes("rename")) {
    if (step === 0) return { reasoning: "The user wants burrow 2 renamed. Renaming changes data, so the app will ask first.", calls: [{ name: "rename_burrow", args: { id: 2, name: "Fern Den" } }] };
    return { text: `${results.at(-1)}\n\nOpen \`burrow://2\` to check the record.` };
  }
  if (user.includes("photo")) {
    if (step === 0) return { calls: [{ name: "burrow_photo", args: { id: 1 } }] };
    return { text: `Here is the photo of burrow://1. I received **${imagesSeen(recent)}** image(s) as visual input: a brown burrow with a green stripe.` };
  }
  if (user.includes("plan")) {
    const steps = (done: number) =>
      ["List the burrows", "Count the badgers", "Write a summary"].map((text, i) => ({ text, status: i < done ? "done" : i === done ? "active" : "pending" }));
    if (step === 0) return { text: "", calls: [{ name: "update_plan", args: { steps: steps(0) } }] };
    if (step === 1) return { calls: [{ name: "list_burrows", args: {} }] };
    if (step === 2) return { calls: [{ name: "update_plan", args: { steps: steps(2) } }] };
    if (step === 3) return { calls: [{ name: "update_plan", args: { steps: steps(3) } }] };
    return { text: "| Burrow | Badgers |\n|---|---|\n| burrow://1 | 3 |\n| burrow://2 | 5 |\n| burrow://3 | 1 |\n\nNine badgers in total." };
  }
  if (user.includes("attach") || user.includes("file") || user.includes("pdf")) {
    const uri = /attachment:\/\/[\w-]+/.exec(lastUser(userItem ? [userItem] : []))?.[0];
    if (!uri) return { text: "Attach a file first (the paperclip), then ask again." };
    if (step === 0) return { calls: [{ name: "read", args: { uri } }] };
    const first = results[0]!.split("\n").slice(2, 4).join(" ").slice(0, 120);
    return { text: `I read \`${uri}\`. It starts with: "${first}". Images received: ${imagesSeen(recent)}.` };
  }
  if (user.includes("postcard")) {
    if (step === 0) return { calls: [{ name: "send_postcard", args: { to: "ollie@river.example", text: "Greetings from Mossy Hollow!" } }] };
    return { text: results.at(-1)! };
  }
  if (user.includes("link")) {
    if (step === 0) return { calls: [{ name: "burrow_link", args: { id: 3 } }] };
    return { text: "The tool card above links to the burrow record." };
  }
  if (user.includes("skill")) {
    if (step === 0) return { calls: [{ name: "read", args: { uri: "skill://burrow-care/SKILL.md" } }] };
    return { text: "I read the burrow-care skill. Its first rule: inspect the entrance before the tunnels." };
  }
  if (user.includes("tab")) {
    if (step === 0) return { calls: [{ name: "whoami", args: {} }] };
    return { text: `The server saw: \`${results.at(-1)}\`` };
  }
  if (user.includes("long")) {
    return { text: Array.from({ length: 30 }, (_, i) => `${i + 1}. Otter number ${i + 1} visits burrow://${(i % 3) + 1} and leaves a pebble.`).join("\n") };
  }
  return {
    reasoning: "A plain question. I answer with some markdown to show the renderer.",
    text: `You said: *${user || "nothing"}*.\n\nTry **rename**, **photo**, **plan**, **postcard**, **link**, **skill**, **tab** or **long**, or attach a file and say **attachment**.\n\n\`\`\`go\nfmt.Println("badgers <3")\n\`\`\`\n\nRecords look like \`burrow://1\`.`,
  };
}
