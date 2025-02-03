import {
  type Message,
  convertToCoreMessages,
  createDataStreamResponse,
  streamObject,
  streamText,
} from 'ai';
import { z } from 'zod';

import { auth, signIn } from '@/app/(auth)/auth';
import { customModel } from '@/lib/ai';
import { models } from '@/lib/ai/models';
import { rateLimiter } from '@/lib/rate-limit';
import {
  codePrompt,
  systemPrompt,
  updateDocumentPrompt,
} from '@/lib/ai/prompts';
import {
  deleteChatById,
  getChatById,
  getDocumentById,
  saveChat,
  saveDocument,
  saveMessages,
  saveSuggestions,
} from '@/lib/db/queries';
import type { Suggestion } from '@/lib/db/schema';
import {
  generateUUID,
  getMostRecentUserMessage,
  sanitizeResponseMessages,
} from '@/lib/utils';

import { generateTitleFromUserMessage } from '../../actions';
import FirecrawlApp from '@mendable/firecrawl-js';

export const maxDuration = 300;

type AllowedTools =
  | 'requestSuggestions'
  | 'deepResearch';

const blocksTools: AllowedTools[] = [
  'requestSuggestions',
];

// const firecrawlTools: AllowedTools[] = ['search', 'extract', 'scrape'];

const allTools: AllowedTools[] = [ 'deepResearch'];

const app = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY || '',
});

export async function POST(request: Request) {
  const {
    id,
    messages,
    modelId,
  }: { id: string; messages: Array<Message>; modelId: string } =
    await request.json();

  let session = await auth();

  // If no session exists, create an anonymous session
  if (!session?.user) {
    try {
      const result = await signIn('credentials', {
        redirect: false,
      });

      if (result?.error) {
        console.error('Failed to create anonymous session:', result.error);
        return new Response('Failed to create anonymous session', {
          status: 500,
        });
      }

      session = await auth();

      if (!session?.user) {
        console.error('Failed to get session after creation');
        return new Response('Failed to create session', { status: 500 });
      }
    } catch (error) {
      console.error('Error creating anonymous session:', error);
      return new Response('Failed to create anonymous session', {
        status: 500,
      });
    }
  }

  if (!session?.user?.id) {
    return new Response('Failed to create session', { status: 500 });
  }

  // Apply rate limiting
  const identifier = session.user.id;
  const { success, limit, reset, remaining } =
    await rateLimiter.limit(identifier);

  if (!success) {
    return new Response(`Too many requests`, { status: 429 });
  }

  const model = models.find((model) => model.id === modelId);

  if (!model) {
    return new Response('Model not found', { status: 404 });
  }

  const coreMessages = convertToCoreMessages(messages);
  const userMessage = getMostRecentUserMessage(coreMessages);

  if (!userMessage) {
    return new Response('No user message found', { status: 400 });
  }

  const chat = await getChatById({ id });

  if (!chat) {
    const title = await generateTitleFromUserMessage({ message: userMessage });
    await saveChat({ id, userId: session.user.id, title });
  }

  const userMessageId = generateUUID();

  await saveMessages({
    messages: [
      { ...userMessage, id: userMessageId, createdAt: new Date(), chatId: id },
    ],
  });

  return createDataStreamResponse({
    execute: (dataStream) => {
      dataStream.writeData({
        type: 'user-message-id',
        content: userMessageId,
      });

      const result = streamText({
        model: customModel(model.apiIdentifier),
        system: systemPrompt,
        messages: coreMessages,
        maxSteps: 5,
        experimental_activeTools: allTools,
        tools: {
          createDocument: {
            description:
              'Create a document for a writing activity. This tool will call other functions that will generate the contents of the document based on the title and kind.',
            parameters: z.object({
              title: z.string(),
              kind: z.enum(['text', 'code', 'spreadsheet']),
            }),
            execute: async ({ title, kind }) => {
              const id = generateUUID();
              let draftText = '';

              dataStream.writeData({
                type: 'id',
                content: id,
              });

              dataStream.writeData({
                type: 'title',
                content: title,
              });

              dataStream.writeData({
                type: 'kind',
                content: kind,
              });

              dataStream.writeData({
                type: 'clear',
                content: '',
              });

              if (kind === 'text') {
                const { fullStream } = streamText({
                  model: customModel(model.apiIdentifier),
                  system:
                    'Write about the given topic. Markdown is supported. Use headings wherever appropriate.',
                  prompt: title,
                });

                for await (const delta of fullStream) {
                  const { type } = delta;

                  if (type === 'text-delta') {
                    const { textDelta } = delta;

                    draftText += textDelta;
                    dataStream.writeData({
                      type: 'text-delta',
                      content: textDelta,
                    });
                  }
                }

                dataStream.writeData({ type: 'finish', content: '' });
              } else if (kind === 'code') {
                const { fullStream } = streamObject({
                  model: customModel(model.apiIdentifier),
                  system: codePrompt,
                  prompt: title,
                  schema: z.object({
                    code: z.string(),
                  }),
                });

                for await (const delta of fullStream) {
                  const { type } = delta;

                  if (type === 'object') {
                    const { object } = delta;
                    const { code } = object;

                    if (code) {
                      dataStream.writeData({
                        type: 'code-delta',
                        content: code ?? '',
                      });

                      draftText = code;
                    }
                  }
                }

                dataStream.writeData({ type: 'finish', content: '' });
              } else if (kind === 'spreadsheet') {
                const { fullStream } = streamObject({
                  model: customModel(model.apiIdentifier),
                  system: `You are a spreadsheet initialization assistant. Create a spreadsheet structure based on the title/description and the chat history.
                    - Create meaningful column headers based on the context and chat history
                    - Keep data types consistent within columns
                    - If the title doesn't suggest specific columns, create a general-purpose structure`,
                  prompt:
                    title +
                    '\n\nChat History:\n' +
                    coreMessages.map((msg) => msg.content).join('\n'),
                  schema: z.object({
                    headers: z
                      .array(z.string())
                      .describe('Column headers for the spreadsheet'),
                    rows: z.array(z.array(z.string())).describe('Data rows'),
                  }),
                });

                let spreadsheetData: { headers: string[]; rows: string[][] } = {
                  headers: [],
                  rows: [[], []],
                };

                for await (const delta of fullStream) {
                  const { type } = delta;

                  if (type === 'object') {
                    const { object } = delta;
                    if (
                      object &&
                      Array.isArray(object.headers) &&
                      Array.isArray(object.rows)
                    ) {
                      // Validate and normalize the data
                      const headers = object.headers.map((h) =>
                        String(h || ''),
                      );
                      const rows = object.rows.map((row) => {
                        // Handle undefined row by creating empty array
                        const safeRow = (row || []).map((cell) =>
                          String(cell || ''),
                        );
                        // Ensure row length matches headers
                        while (safeRow.length < headers.length)
                          safeRow.push('');
                        return safeRow.slice(0, headers.length);
                      });

                      spreadsheetData = { headers, rows };
                    }
                  }
                }

                draftText = JSON.stringify(spreadsheetData);
                dataStream.writeData({
                  type: 'spreadsheet-delta',
                  content: draftText,
                });

                dataStream.writeData({ type: 'finish', content: '' });
              }

              if (session.user?.id) {
                await saveDocument({
                  id,
                  title,
                  kind,
                  content: draftText,
                  userId: session.user.id,
                });
              }

              return {
                id,
                title,
                kind,
                content:
                  'A document was created and is now visible to the user.',
              };
            },
          },
          updateDocument: {
            description: 'Update a document with the given description.',
            parameters: z.object({
              id: z.string().describe('The ID of the document to update'),
              description: z
                .string()
                .describe('The description of changes that need to be made'),
            }),
            execute: async ({ id, description }) => {
              const document = await getDocumentById({ id });

              if (!document) {
                return {
                  error: 'Document not found',
                };
              }

              const { content: currentContent } = document;
              let draftText = '';

              dataStream.writeData({
                type: 'clear',
                content: document.title,
              });

              if (document.kind === 'text') {
                const { fullStream } = streamText({
                  model: customModel(model.apiIdentifier),
                  system: updateDocumentPrompt(currentContent, 'text'),
                  prompt: description,
                  experimental_providerMetadata: {
                    openai: {
                      prediction: {
                        type: 'content',
                        content: currentContent,
                      },
                    },
                  },
                });

                for await (const delta of fullStream) {
                  const { type } = delta;

                  if (type === 'text-delta') {
                    const { textDelta } = delta;

                    draftText += textDelta;
                    dataStream.writeData({
                      type: 'text-delta',
                      content: textDelta,
                    });
                  }
                }

                dataStream.writeData({ type: 'finish', content: '' });
              } else if (document.kind === 'code') {
                const { fullStream } = streamObject({
                  model: customModel(model.apiIdentifier),
                  system: updateDocumentPrompt(currentContent, 'code'),
                  prompt: description,
                  schema: z.object({
                    code: z.string(),
                  }),
                });

                for await (const delta of fullStream) {
                  const { type } = delta;

                  if (type === 'object') {
                    const { object } = delta;
                    const { code } = object;

                    if (code) {
                      dataStream.writeData({
                        type: 'code-delta',
                        content: code ?? '',
                      });

                      draftText = code;
                    }
                  }
                }

                dataStream.writeData({ type: 'finish', content: '' });
              } else if (document.kind === 'spreadsheet') {
                // Parse the current content as spreadsheet data
                let currentSpreadsheetData = { headers: [], rows: [] };
                try {
                  if (currentContent) {
                    currentSpreadsheetData = JSON.parse(currentContent);
                  }
                } catch {
                  // Keep default empty structure
                }

                const { fullStream } = streamObject({
                  model: customModel(model.apiIdentifier),
                  system: `You are a spreadsheet manipulation assistant. The current spreadsheet has the following structure:
                    Headers: ${JSON.stringify(currentSpreadsheetData.headers)}
                    Current rows: ${JSON.stringify(currentSpreadsheetData.rows)}
                    
                    When modifying the spreadsheet:
                    1. You can add, remove, or modify columns (headers)
                    2. When adding columns, add empty values to existing rows for the new columns
                    3. When removing columns, remove the corresponding values from all rows
                    4. Return the COMPLETE spreadsheet data including ALL headers and rows
                    5. Format response as valid JSON with 'headers' and 'rows' arrays
                    
                    Example response format:
                    {"headers":["Name","Email","Phone"],"rows":[["John","john@example.com","123-456-7890"],["Jane","jane@example.com","098-765-4321"]]}`,
                  prompt: `${description}\n\nChat History:\n${coreMessages
                    .map((msg) => msg.content)
                    .join('\n')}`,
                  schema: z.object({
                    headers: z
                      .array(z.string())
                      .describe('Column headers for the spreadsheet'),
                    rows: z
                      .array(z.array(z.string()))
                      .describe('Sample data rows'),
                  }),
                });

                let updatedContent = '';
                draftText = JSON.stringify(currentSpreadsheetData);

                for await (const delta of fullStream) {
                  const { type } = delta;

                  if (type === 'object') {
                    const { object } = delta;
                    if (
                      object &&
                      Array.isArray(object.headers) &&
                      Array.isArray(object.rows)
                    ) {
                      // Validate and normalize the data
                      const headers = object.headers.map((h: any) =>
                        String(h || ''),
                      );
                      const rows = object.rows.map(
                        (row: (string | undefined)[] | undefined) => {
                          const normalizedRow = (row || []).map((cell: any) =>
                            String(cell || ''),
                          );
                          // Ensure row length matches new headers length
                          while (normalizedRow.length < headers.length) {
                            normalizedRow.push('');
                          }
                          return normalizedRow.slice(0, headers.length);
                        },
                      );

                      const newData = { headers, rows };
                      draftText = JSON.stringify(newData);
                      dataStream.writeData({
                        type: 'spreadsheet-delta',
                        content: draftText,
                      });
                    }
                  }
                }

                dataStream.writeData({ type: 'finish', content: '' });
              }

              if (session.user?.id) {
                await saveDocument({
                  id,
                  title: document.title,
                  content: draftText,
                  kind: document.kind,
                  userId: session.user.id,
                });
              }

              return {
                id,
                title: document.title,
                kind: document.kind,
                content: 'The document has been updated successfully.',
              };
            },
          },
          requestSuggestions: {
            description: 'Request suggestions for a document',
            parameters: z.object({
              documentId: z
                .string()
                .describe('The ID of the document to request edits'),
            }),
            execute: async ({ documentId }) => {
              const document = await getDocumentById({ id: documentId });

              if (!document || !document.content) {
                return {
                  error: 'Document not found',
                };
              }

              const suggestions: Array<
                Omit<Suggestion, 'userId' | 'createdAt' | 'documentCreatedAt'>
              > = [];

              const { elementStream } = streamObject({
                model: customModel(model.apiIdentifier),
                system:
                  'You are a help writing assistant. Given a piece of writing, please offer suggestions to improve the piece of writing and describe the change. It is very important for the edits to contain full sentences instead of just words. Max 5 suggestions.',
                prompt: document.content,
                output: 'array',
                schema: z.object({
                  originalSentence: z
                    .string()
                    .describe('The original sentence'),
                  suggestedSentence: z
                    .string()
                    .describe('The suggested sentence'),
                  description: z
                    .string()
                    .describe('The description of the suggestion'),
                }),
              });

              for await (const element of elementStream) {
                const suggestion = {
                  originalText: element.originalSentence,
                  suggestedText: element.suggestedSentence,
                  description: element.description,
                  id: generateUUID(),
                  documentId: documentId,
                  isResolved: false,
                };

                dataStream.writeData({
                  type: 'suggestion',
                  content: suggestion,
                });

                suggestions.push(suggestion);
              }

              if (session.user?.id) {
                const userId = session.user.id;

                await saveSuggestions({
                  suggestions: suggestions.map((suggestion) => ({
                    ...suggestion,
                    userId,
                    createdAt: new Date(),
                    documentCreatedAt: document.createdAt,
                  })),
                });
              }

              return {
                id: documentId,
                title: document.title,
                kind: document.kind,
                message: 'Suggestions have been added to the document',
              };
            },
          },
          search: {
            description:
              "Search for web pages. Normally you should call the extract tool after this one to get a spceific data point if search doesn't the exact data you need.",
            parameters: z.object({
              query: z
                .string()
                .describe('Search query to find relevant web pages'),
              maxResults: z
                .number()
                .optional()
                .describe('Maximum number of results to return (default 10)'),
            }),
            execute: async ({ query, maxResults = 5 }) => {
              try {
                const searchResult = await app.search(query);

                if (!searchResult.success) {
                  return {
                    error: `Search failed: ${searchResult.error}`,
                    success: false,
                  };
                }

                return {
                  data: searchResult.data,
                  success: true,
                };
              } catch (error: any) {
                return {
                  error: `Search failed: ${error.message}`,
                  success: false,
                };
              }
            },
          },
          extract: {
            description:
              'Extract structured data from web pages. Use this to get wahtever data you need from a URL. Any time someone needs to gather data from something, use this tool.',
            parameters: z.object({
              urls: z.array(z.string()).describe(
                'Array of URLs to extract data from',
                // , include a /* at the end of each URL if you think you need to search for other pages insdes that URL to extract the full data from',
              ),
              prompt: z
                .string()
                .describe('Description of what data to extract'),
            }),
            execute: async ({ urls, prompt }) => {
              try {
                console.log(urls);
                const scrapeResult = await app.extract(urls, {
                  prompt,
                });

                console.log(scrapeResult);

                if (!scrapeResult.success) {
                  return {
                    error: `Failed to extract data: ${scrapeResult.error}`,
                    success: false,
                  };
                }

                return {
                  data: scrapeResult.data,
                  success: true,
                };
              } catch (error: any) {
                console.error('Extraction error:', error);
                console.error(error.message);
                console.error(error.error);
                return {
                  error: `Extraction failed: ${error.message}`,
                  success: false,
                };
              }
            },
          },
          scrape: {
            description:
              'Scrape web pages. Use this to get from a page when you have the url.',
            parameters: z.object({
              url: z.string().describe('URL to scrape'),
            }),
            execute: async ({ url }: { url: string }) => {
              try {
                const scrapeResult = await app.scrapeUrl(url);

                console.log(scrapeResult);

                if (!scrapeResult.success) {
                  return {
                    error: `Failed to extract data: ${scrapeResult.error}`,
                    success: false,
                  };
                }

                return {
                  data:
                    scrapeResult.markdown ??
                    'Could get the page content, try using search or extract',
                  success: true,
                };
              } catch (error: any) {
                console.error('Extraction error:', error);
                console.error(error.message);
                console.error(error.error);
                return {
                  error: `Extraction failed: ${error.message}`,
                  success: false,
                };
              }
            },
          },
          deepResearch: {
            description: 'Perform deep research on a topic using a combination of search, extract, and analysis tools.',
            parameters: z.object({
              topic: z.string().describe('The topic or question to research'),
              maxDepth: z.number().optional().describe('Maximum depth of research iterations'),
            }),
            execute: async ({ topic, maxDepth = 3 }) => {
              const researchState = {
                activity: [] as Array<{
                  type: 'search' | 'extract' | 'analyze';
                  status: 'pending' | 'complete' | 'error';
                  message: string;
                  timestamp: string;
                }>,
                sources: [] as Array<{
                  url: string;
                  title: string;
                  relevance: number;
                }>,
                findings: [] as Array<string>,
              };

              const addActivity = (activity: typeof researchState.activity[0]) => {
                researchState.activity.push(activity);
                // Stream each activity update immediately
                dataStream.writeData({
                  type: 'activity-delta',
                  content: activity
                });
              };

              const addSource = (source: typeof researchState.sources[0]) => {
                if (!researchState.sources.find(s => s.url === source.url)) {
                  researchState.sources.push(source);
                  // Stream each source update immediately
                  dataStream.writeData({
                    type: 'source-delta',
                    content: source
                  });
                }
              };

              

              try {
                // Initial search activity
                addActivity({
                  type: 'search',
                  status: 'pending',
                  message: `Searching for information about "${topic}"`,
                  timestamp: new Date().toISOString(),
                });

                const searchResult = await app.search(topic);
                
                if (!searchResult.success) {
                  throw new Error(`Search failed: ${searchResult.error}`);
                }

                // Stream search completion activity
                addActivity({
                  type: 'search',
                  status: 'complete',
                  message: `Found ${searchResult.data.length} relevant results`,
                  timestamp: new Date().toISOString(),
                });

                // Stream sources from search
                searchResult.data.forEach((result: any) => {
                  addSource({
                    url: result.url,
                    title: result.title,
                    relevance: result.score || 0.5,
                  });
                });

                // Extract information from top sources
                const topUrls = searchResult.data
                  .slice(0, 3)
                  .map((result: any) => result.url);

                const findings: string[] = [];

                for (const url of topUrls) {
                  // Stream extraction start activity
                  addActivity({
                    type: 'extract',
                    status: 'pending',
                    message: `Extracting information from ${new URL(url).hostname}`,
                    timestamp: new Date().toISOString(),
                  });

                  try {
                    const extractResult = await app.extract([url], {
                      prompt: `Extract key information about ${topic}. Focus on factual data, statistics, and expert opinions.`,
                    });

                    if (extractResult.success) {
                      // Stream extraction success activity
                      addActivity({
                        type: 'extract',
                        status: 'complete',
                        message: `Successfully extracted information from ${new URL(url).hostname}`,
                        timestamp: new Date().toISOString(),
                      });

                      if (Array.isArray(extractResult.data)) {
                        findings.push(...extractResult.data.map((item: any) => item.data));
                      } else {
                        findings.push(extractResult.data);
                      }

                      // Stream each finding immediately
                      dataStream.writeData({
                        type: 'text-delta',
                        content: extractResult.data + '\n'
                      });
                    } else {
                      // Stream extraction error activity
                      addActivity({
                        type: 'extract',
                        status: 'error',
                        message: `Failed to extract from ${new URL(url).hostname}: ${extractResult.error}`,
                        timestamp: new Date().toISOString(),
                      });
                    }
                  } catch (error: any) {
                    console.error('Extraction error for URL:', url, error);
                    // Stream extraction error activity
                    addActivity({
                      type: 'extract',
                      status: 'error',
                      message: `Failed to extract from ${new URL(url).hostname}: ${error.message}`,
                      timestamp: new Date().toISOString(),
                    });
                  }

                  // Add a small delay between extractions
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }

                // Only proceed with analysis if we have findings
                if (findings.length > 0) {
                  // Stream analysis start activity
                  addActivity({
                    type: 'analyze',
                    status: 'pending',
                    message: 'Analyzing and synthesizing findings',
                    timestamp: new Date().toISOString(),
                  });

                  researchState.findings = findings;

                  // Stream analysis completion activity
                  addActivity({
                    type: 'analyze',
                    status: 'complete',
                    message: `Analysis complete - Found information from ${findings.length} sources`,
                    timestamp: new Date().toISOString(),
                  });

                  // Stream final summary
                  dataStream.writeData({
                    type: 'finish',
                    content: ''
                  });

                  return {
                    success: true,
                    data: {
                      activity: researchState.activity,
                      sources: researchState.sources,
                      findings: researchState.findings,
                    },
                  };
                } else {
                  throw new Error('No information could be extracted from the sources');
                }

              } catch (error: any) {
                console.error('Deep research error:', error);
                // Stream error activity
                addActivity({
                  type: 'analyze',
                  status: 'error',
                  message: `Research failed: ${error.message}`,
                  timestamp: new Date().toISOString(),
                });

                // Stream error state
                dataStream.writeData({
                  type: 'finish',
                  content: ''
                });

                return {
                  success: false,
                  error: error.message,
                  data: {
                    activity: researchState.activity,
                    sources: researchState.sources,
                    findings: researchState.findings,
                  },
                };
              }
            },
          },
        },
        onFinish: async ({ response }) => {
          if (session.user?.id) {
            try {
              const responseMessagesWithoutIncompleteToolCalls =
                sanitizeResponseMessages(response.messages);

              await saveMessages({
                messages: responseMessagesWithoutIncompleteToolCalls.map(
                  (message) => {
                    const messageId = generateUUID();

                    if (message.role === 'assistant') {
                      dataStream.writeMessageAnnotation({
                        messageIdFromServer: messageId,
                      });
                    }

                    return {
                      id: messageId,
                      chatId: id,
                      role: message.role,
                      content: message.content,
                      createdAt: new Date(),
                    };
                  },
                ),
              });
            } catch (error) {
              console.error('Failed to save chat');
            }
          }
        },
        experimental_telemetry: {
          isEnabled: true,
          functionId: 'stream-text',
        },
      });

      result.mergeIntoDataStream(dataStream);
    },
  });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Not Found', { status: 404 });
  }

  let session = await auth();

  // If no session exists, create an anonymous session
  if (!session?.user) {
    await signIn('credentials', {
      redirect: false,
    });
    session = await auth();
  }

  if (!session?.user?.id) {
    return new Response('Failed to create session', { status: 500 });
  }

  try {
    const chat = await getChatById({ id });

    if (chat.userId !== session.user.id) {
      return new Response('Unauthorized', { status: 401 });
    }

    await deleteChatById({ id });

    return new Response('Chat deleted', { status: 200 });
  } catch (error) {
    return new Response('An error occurred while processing your request', {
      status: 500,
    });
  }
}
