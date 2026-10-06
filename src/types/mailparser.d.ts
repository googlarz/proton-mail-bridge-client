declare module "mailparser" {
  export interface AddressEntry {
    name?: string;
    address?: string;
  }

  export interface AddressObject {
    value: AddressEntry[];
    text?: string;
    html?: string;
  }

  export interface Attachment {
    filename?: string;
    contentType?: string;
    size?: number;
    cid?: string;
    checksum?: string;
    contentDisposition?: string;
    // The attachment part's own headers (mailparser keeps them): content-type carries the charset parameter.
    headers?: Map<string, unknown>;
    content: Buffer;
  }

  export interface ParsedMail {
    subject?: string;
    text?: string;
    html?: string | false;
    messageId?: string;
    date?: Date;
    headers: Map<string, unknown>;
    from?: AddressObject;
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
    replyTo?: AddressObject;
    attachments?: Attachment[];
  }

  export function simpleParser(
    source: string | Buffer | NodeJS.ReadableStream,
    options?: unknown,
  ): Promise<ParsedMail>;
}
