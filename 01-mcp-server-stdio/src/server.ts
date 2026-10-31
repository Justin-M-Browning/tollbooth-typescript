import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  GetCustomerRecordInputSchema,
  TriggerRefundInputSchema,
} from './schemas.js';
import { db } from './db.js';
import { logger } from './logger.js';

export const SERVER_NAME = 'mcp-customer-service';
export const SERVER_VERSION = '1.0.0';

export const TOOLS: Tool[] = [
  {
    name: 'get_customer_record',
    description: 'Retrieve full customer profile and account details by customer ID.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          pattern: '^CUST-[A-Za-z0-9]{5}$',
          description: 'Unique customer identifier formatted as CUST-XXXXX (e.g. CUST-10001, CUST-ABCDE).',
        },
      },
      required: ['customer_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'trigger_refund',
    description: 'Trigger a monetary refund transaction for a customer with strict validation.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          pattern: '^CUST-[A-Za-z0-9]{5}$',
          description: 'Unique customer identifier formatted as CUST-XXXXX.',
        },
        amount: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Positive float refund amount (must be strictly greater than 0).',
        },
        reason: {
          type: 'string',
          minLength: 10,
          description: 'Justification for refund (minimum length 10 characters).',
        },
      },
      required: ['customer_id', 'amount', 'reason'],
      additionalProperties: false,
    },
  },
];

export function createCustomerServer(): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug('Handling ListTools request');
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    logger.info(`Received tool invocation request for: ${name}`, { args: rawArgs });

    switch (name) {
      case 'get_customer_record': {
        const validation = GetCustomerRecordInputSchema.safeParse(rawArgs);
        if (!validation.success) {
          const errorMessages = validation.error.issues
            .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
            .join('; ');
          logger.warn(`Validation failed for get_customer_record: ${errorMessages}`);
          throw new McpError(
            ErrorCode.InvalidParams,
            `Validation error for get_customer_record: ${errorMessages}`
          );
        }

        const { customer_id } = validation.data;
        const customer = db.getCustomer(customer_id);

        if (!customer) {
          logger.warn(`Customer not found: ${customer_id}`);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    found: false,
                    customer_id,
                    message: `Customer ${customer_id} does not exist in records`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        logger.info(`Customer record retrieved successfully: ${customer_id}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(customer, null, 2),
            },
          ],
        };
      }

      case 'trigger_refund': {
        const validation = TriggerRefundInputSchema.safeParse(rawArgs);
        if (!validation.success) {
          const errorMessages = validation.error.issues
            .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
            .join('; ');
          logger.warn(`Validation failed for trigger_refund: ${errorMessages}`);
          throw new McpError(
            ErrorCode.InvalidParams,
            `Validation error for trigger_refund: ${errorMessages}`
          );
        }

        const { customer_id, amount, reason } = validation.data;
        const refundResult = db.processRefund(customer_id, amount, reason);

        logger.info(`Refund processed successfully: ${refundResult.refund_id}`, refundResult);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(refundResult, null, 2),
            },
          ],
        };
      }

      default: {
        logger.error(`Unknown tool invoked: ${name}`);
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: '${name}'. Available tools: ${TOOLS.map((t) => t.name).join(', ')}`
        );
      }
    }
  });

  return server;
}

