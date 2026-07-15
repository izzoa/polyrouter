/**
 * OpenAI Chat Completions wire shapes (request, response, stream chunk) used at
 * the adapter boundary so `openai.ts` isn't typed against `any`. Permissive by
 * design — real payloads carry fields we intentionally drop (§ canonicalizer).
 */

export interface OaiTextPart {
  type: 'text';
  text: string;
}
export interface OaiImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}
export type OaiContentPart = OaiTextPart | OaiImagePart;

export interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OaiMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: string | OaiContentPart[] | null;
  name?: string;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}

export interface OaiTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type OaiToolChoice =
  'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

export interface OaiRequest {
  model: string;
  messages: OaiMessage[];
  tools?: OaiTool[];
  tool_choice?: OaiToolChoice;
  parallel_tool_calls?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  n?: number;
}

export interface OaiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface OaiResponseMessage {
  role: 'assistant';
  content?: string | null;
  tool_calls?: OaiToolCall[];
}

export interface OaiChoice {
  index: number;
  message: OaiResponseMessage;
  finish_reason: string | null;
}

export interface OaiResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OaiChoice[];
  usage?: OaiUsage;
}

export interface OaiDeltaToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface OaiChunkDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: OaiDeltaToolCall[];
}

export interface OaiChunkChoice {
  index: number;
  delta: OaiChunkDelta;
  finish_reason?: string | null;
}

export interface OaiChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OaiChunkChoice[];
  usage?: OaiUsage | null;
}
