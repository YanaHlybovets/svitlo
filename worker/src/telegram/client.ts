// Minimal Telegram Bot API client. The token never appears in logs.

export type TgResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } };

export interface TelegramClient {
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<TgResult<T>>;
}

export function telegramClient(token: string, fetcher: typeof fetch = fetch): TelegramClient {
  return {
    async call<T>(method: string, params: Record<string, unknown>): Promise<TgResult<T>> {
      try {
        const res = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
        });
        return (await res.json()) as TgResult<T>;
      } catch (error) {
        return { ok: false, error_code: 0, description: `network: ${(error as Error).message}` };
      }
    },
  };
}

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type Keyboard = InlineButton[][];

export const button = (text: string, callback_data: string): InlineButton => ({ text, callback_data });
