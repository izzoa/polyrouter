/**
 * Anthropic Messages wire shapes (request, response, stream events) used at the
 * adapter boundary so `anthropic.ts` isn't typed against `any`.
 */

export interface AntTextBlock {
  type: 'text';
  text: string;
  cache_control?: unknown;
}
export interface AntImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
}
export interface AntToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  cache_control?: unknown;
}
export interface AntToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AntContentBlock[];
  is_error?: boolean;
  cache_control?: unknown;
}
export type AntContentBlock = AntTextBlock | AntImageBlock | AntToolUseBlock | AntToolResultBlock;

export interface AntMessage {
  role: 'user' | 'assistant';
  content: string | AntContentBlock[];
}

export interface AntTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: unknown;
}

export interface AntToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none';
  name?: string;
  disable_parallel_tool_use?: boolean;
}

export interface AntRequest {
  model: string;
  system?: string | AntTextBlock[];
  messages: AntMessage[];
  max_tokens: number;
  tools?: AntTool[];
  tool_choice?: AntToolChoice;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  thinking?: unknown;
  stream?: boolean;
}

export interface AntUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AntResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AntContentBlock[];
  stop_reason: string | null;
  stop_sequence?: string | null;
  usage?: AntUsage;
}

// --- Stream events ---

export interface AntStreamMessageStart {
  type: 'message_start';
  message: {
    id: string;
    model: string;
    role: 'assistant';
    usage?: Partial<AntUsage> & { output_tokens?: number };
  };
}
export interface AntStreamContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block:
    { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };
}
export interface AntStreamContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string };
}
export interface AntStreamContentBlockStop {
  type: 'content_block_stop';
  index: number;
}
export interface AntStreamMessageDelta {
  type: 'message_delta';
  delta: { stop_reason?: string | null; stop_sequence?: string | null };
  usage?: { output_tokens?: number };
}
export interface AntStreamMessageStop {
  type: 'message_stop';
}
export interface AntStreamPing {
  type: 'ping';
}
export interface AntStreamError {
  type: 'error';
  error: { type: string; message: string };
}
export type AntStreamEvent =
  | AntStreamMessageStart
  | AntStreamContentBlockStart
  | AntStreamContentBlockDelta
  | AntStreamContentBlockStop
  | AntStreamMessageDelta
  | AntStreamMessageStop
  | AntStreamPing
  | AntStreamError;
