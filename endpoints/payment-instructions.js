const { createHandler } = require('@app-core/server');
const { appLogger } = require('@app-core/logger');
const paymentInstructionService = require('@app/services/payment-instruction');

module.exports = createHandler({
  path: '/payment-instructions',
  method: 'post',
  middlewares: [],
  async onResponseEnd(rc, rs) {
    appLogger.info({ requestContext: rc, response: rs }, 'payment-instruction-request-completed');
  },
  async handler(rc, helpers) {
    const payload = rc.body;

    try {
      const response = await paymentInstructionService(payload);

      // Return HTTP 200 for successful and pending transactions
      if (response.status === 'successful' || response.status === 'pending') {
        return {
          status: helpers.http_statuses.HTTP_200_OK,
          data: response,
        };
      }

      // Return HTTP 400 for validation errors and parsing failures
      return {
        status: helpers.http_statuses.HTTP_400_BAD_REQUEST,
        data: response,
      };
    } catch (error) {
      appLogger.error({ error, payload }, 'payment-instruction-service-error');

      return {
        status: helpers.http_statuses.HTTP_500_INTERNAL_SERVER_ERROR,
        data: {
          type: null,
          amount: null,
          currency: null,
          debit_account: null,
          credit_account: null,
          execute_by: null,
          status: 'failed',
          status_reason: 'Internal server error',
          status_code: 'SY03',
          accounts: [],
        },
      };
    }
  },
});
