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
export declare function systemPrompt(input: PromptInput): string;
