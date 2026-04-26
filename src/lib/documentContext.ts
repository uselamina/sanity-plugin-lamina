/**
 * Lightweight store for tracking the last-viewed document context.
 * Updated by LaminaImageInput and regenerateAction when they interact
 * with a document. Read by LaminaTool to populate the lamina:context
 * postMessage sent to the embed iframe.
 */

export interface DocumentContext {
  documentId: string;
  documentType: string;
  documentTitle: string | null;
  fieldName: string | null;
  fieldType: 'image' | 'file' | null;
}

let lastContext: DocumentContext | null = null;

export function setDocumentContext(ctx: DocumentContext): void {
  lastContext = ctx;
}

export function getDocumentContext(): DocumentContext | null {
  return lastContext;
}
