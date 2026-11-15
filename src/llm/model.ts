/**
 * The model the assignment recommends. "fp8-fast" is an 8-bit quantised build
 * of Llama 3.3 70B tuned for low latency on Workers AI. It supports tool
 * (function) calling, which the chat tools rely on.
 *
 * In its own module so the Workflow and the agent share it without the
 * Workflow importing the whole agent class.
 */
export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
