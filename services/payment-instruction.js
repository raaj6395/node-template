const { appLogger } = require('@app-core/logger');

const SUPPORTED_CURRENCIES = ['NGN', 'USD', 'GBP', 'GHS'];

const STATUS_CODES = {
  AM01: 'Amount must be a positive integer',
  CU01: 'Account currency mismatch',
  CU02: 'Unsupported currency. Only NGN, USD, GBP, and GHS are supported',
  AC01: 'Insufficient funds in debit account',
  AC02: 'Debit and credit accounts cannot be the same',
  AC03: 'Account not found',
  AC04: 'Invalid account ID format',
  DT01: 'Invalid date format',
  SY01: 'Missing required keyword',
  SY02: 'Invalid keyword order',
  SY03: 'Malformed instruction: unable to parse keywords',
  AP00: 'Transaction executed successfully',
  AP02: 'Transaction scheduled for future execution',
};

/**
 * Find keyword index in parts array, optionally starting from a position
 */
function findKeywordIndex(parts, keyword, startFrom = 0) {
  for (let i = startFrom; i < parts.length; i++) {
    if (parts[i] === keyword) {
      return i;
    }
  }
  return -1;
}

/**
 * Extract account ID preserving original case
 */
function extractAccountId(originalInstruction, accountPosition, parts) {
  const normalizedParts = originalInstruction.trim().replace(/\s+/g, ' ').split(' ');
  if (accountPosition < normalizedParts.length) {
    return normalizedParts[accountPosition];
  }
  return parts[accountPosition] || '';
}

/**
 * Validate account ID format
 */
function isValidAccountId(accountId) {
  if (!accountId || typeof accountId !== 'string') return false;

  // Account ID can contain letters, numbers, hyphens, periods, and at symbols
  for (let i = 0; i < accountId.length; i++) {
    const char = accountId[i];
    if (!/[a-zA-Z0-9.@-]/.test(char)) {
      return false;
    }
  }
  return true;
}

/**
 * Validate date format (YYYY-MM-DD)
 */
function isValidDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false;

  // Check format YYYY-MM-DD
  if (dateStr.length !== 10 || dateStr[4] !== '-' || dateStr[7] !== '-') {
    return false;
  }

  const parts = dateStr.split('-');
  if (parts.length !== 3) return false;

  const year = Number.parseInt(parts[0], 10);
  const month = Number.parseInt(parts[1], 10);
  const day = Number.parseInt(parts[2], 10);

  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return false;
  if (year < 1000 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  // Additional validation using Date object
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/**
 * Check if date is in the past or today (UTC)
 */
function isDateInPastOrToday(dateStr) {
  const targetDate = new Date(`${dateStr}T00:00:00.000Z`);
  const today = new Date();
  const todayUTC = new Date(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  return targetDate <= todayUTC;
}

/**
 * Create accounts response array with only involved accounts
 */
function createAccountsResponse(accounts, debitAccountId, creditAccountId, includeBalanceBefore) {
  const result = [];

  accounts.forEach((acc) => {
    if (acc.id === debitAccountId || acc.id === creditAccountId) {
      const accountResponse = {
        id: acc.id,
        balance: acc.balance,
        currency: acc.currency.toUpperCase(),
      };

      if (includeBalanceBefore) {
        accountResponse.balance_before =
          acc.balance_before !== undefined ? acc.balance_before : acc.balance;
      } else {
        accountResponse.balance_before = acc.balance;
      }

      result.push(accountResponse);
    }
  });

  return result;
}

/**
 * Create error response
 */
function createErrorResponse(
  type,
  amount,
  currency,
  debitAccount,
  creditAccount,
  executeBy,
  status,
  statusReason,
  statusCode,
  accounts
) {
  let parsedAmount = null;
  if (amount) {
    const temp = Number.parseInt(amount, 10);
    parsedAmount = Number.isNaN(temp) ? null : temp;
  }

  return {
    type,
    amount: parsedAmount,
    currency: currency ? currency.toUpperCase() : null,
    debit_account: debitAccount,
    credit_account: creditAccount,
    execute_by: executeBy,
    status,
    status_reason: statusReason,
    status_code: statusCode,
    accounts,
  };
}

/**
 * Create success response
 */
function createSuccessResponse(parsedData, status, statusReason, statusCode, accounts) {
  const amount = Number.parseInt(parsedData.amount, 10);

  return {
    type: parsedData.type,
    amount,
    currency: parsedData.currency.toUpperCase(),
    debit_account: parsedData.debit_account,
    credit_account: parsedData.credit_account,
    execute_by: parsedData.execute_by,
    status,
    status_reason: statusReason,
    status_code: statusCode,
    accounts,
  };
}

/**
 * Parse DEBIT instruction format
 * DEBIT [amount] [currency] FROM ACCOUNT [account_id] FOR CREDIT TO ACCOUNT [account_id] [ON [date]]
 */
function parseDebitInstruction(parts, originalInstruction) {
  try {
    const fromIndex = findKeywordIndex(parts, 'FROM');
    const accountIndex1 = findKeywordIndex(parts, 'ACCOUNT', fromIndex);
    const forIndex = findKeywordIndex(parts, 'FOR');
    const creditIndex = findKeywordIndex(parts, 'CREDIT', forIndex);
    const toIndex = findKeywordIndex(parts, 'TO', creditIndex);
    const accountIndex2 = findKeywordIndex(parts, 'ACCOUNT', toIndex);
    const onIndex = findKeywordIndex(parts, 'ON', accountIndex2);

    if (
      fromIndex === -1 ||
      accountIndex1 === -1 ||
      forIndex === -1 ||
      creditIndex === -1 ||
      toIndex === -1 ||
      accountIndex2 === -1
    ) {
      return {
        success: false,
        error_message: STATUS_CODES.SY01,
        error_code: 'SY01',
      };
    }

    if (
      !(
        fromIndex < accountIndex1 &&
        accountIndex1 < forIndex &&
        forIndex < creditIndex &&
        creditIndex < toIndex &&
        toIndex < accountIndex2
      )
    ) {
      return {
        success: false,
        error_message: STATUS_CODES.SY02,
        error_code: 'SY02',
      };
    }

    const amount = parts[1];
    const currency = parts[2];

    const debitAccount = extractAccountId(originalInstruction, accountIndex1 + 1, parts);
    const creditAccount = extractAccountId(originalInstruction, accountIndex2 + 1, parts);

    let executeBy = null;
    if (onIndex !== -1 && onIndex + 1 < parts.length) {
      executeBy = parts[onIndex + 1];
    }

    return {
      success: true,
      data: {
        amount,
        currency,
        debit_account: debitAccount,
        credit_account: creditAccount,
        execute_by: executeBy,
      },
    };
  } catch (error) {
    return {
      success: false,
      error_message: STATUS_CODES.SY03,
      error_code: 'SY03',
    };
  }
}

/**
 * Parse CREDIT instruction format
 * CREDIT [amount] [currency] TO ACCOUNT [account_id] FOR DEBIT FROM ACCOUNT [account_id] [ON [date]]
 */
function parseCreditInstruction(parts, originalInstruction) {
  try {
    const toIndex = findKeywordIndex(parts, 'TO');
    const accountIndex1 = findKeywordIndex(parts, 'ACCOUNT', toIndex);
    const forIndex = findKeywordIndex(parts, 'FOR');
    const debitIndex = findKeywordIndex(parts, 'DEBIT', forIndex);
    const fromIndex = findKeywordIndex(parts, 'FROM', debitIndex);
    const accountIndex2 = findKeywordIndex(parts, 'ACCOUNT', fromIndex);
    const onIndex = findKeywordIndex(parts, 'ON', accountIndex2);

    if (
      toIndex === -1 ||
      accountIndex1 === -1 ||
      forIndex === -1 ||
      debitIndex === -1 ||
      fromIndex === -1 ||
      accountIndex2 === -1
    ) {
      return {
        success: false,
        error_message: STATUS_CODES.SY01,
        error_code: 'SY01',
      };
    }

    if (
      !(
        toIndex < accountIndex1 &&
        accountIndex1 < forIndex &&
        forIndex < debitIndex &&
        debitIndex < fromIndex &&
        fromIndex < accountIndex2
      )
    ) {
      return {
        success: false,
        error_message: STATUS_CODES.SY02,
        error_code: 'SY02',
      };
    }

    const amount = parts[1];
    const currency = parts[2];

    const creditAccount = extractAccountId(originalInstruction, accountIndex1 + 1, parts);
    const debitAccount = extractAccountId(originalInstruction, accountIndex2 + 1, parts);

    let executeBy = null;
    if (onIndex !== -1 && onIndex + 1 < parts.length) {
      executeBy = parts[onIndex + 1];
    }

    return {
      success: true,
      data: {
        amount,
        currency,
        debit_account: debitAccount,
        credit_account: creditAccount,
        execute_by: executeBy,
      },
    };
  } catch (error) {
    return {
      success: false,
      error_message: STATUS_CODES.SY03,
      error_code: 'SY03',
    };
  }
}

/**
 * Validate business rules
 */
function validateBusinessRules(parsedData, accounts) {
  const {
    amount: rawAmount,
    currency,
    debit_account: debitAccount,
    credit_account: creditAccount,
    execute_by: executeBy,
  } = parsedData;

  const parsedAmount = Number.parseInt(rawAmount, 10);

  if (!rawAmount || Number.isNaN(parsedAmount) || parsedAmount <= 0 || rawAmount.includes('.')) {
    return {
      success: false,
      error_message: STATUS_CODES.AM01,
      error_code: 'AM01',
    };
  }

  if (!currency || !SUPPORTED_CURRENCIES.includes(currency.toUpperCase())) {
    return {
      success: false,
      error_message: STATUS_CODES.CU02,
      error_code: 'CU02',
    };
  }

  if (!isValidAccountId(debitAccount) || !isValidAccountId(creditAccount)) {
    return {
      success: false,
      error_message: STATUS_CODES.AC04,
      error_code: 'AC04',
    };
  }

  if (debitAccount === creditAccount) {
    return {
      success: false,
      error_message: STATUS_CODES.AC02,
      error_code: 'AC02',
    };
  }

  const debitAcc = accounts.find((acc) => acc.id === debitAccount);
  const creditAcc = accounts.find((acc) => acc.id === creditAccount);

  if (!debitAcc || !creditAcc) {
    return {
      success: false,
      error_message: STATUS_CODES.AC03,
      error_code: 'AC03',
    };
  }

  if (
    debitAcc.currency.toUpperCase() !== creditAcc.currency.toUpperCase() ||
    debitAcc.currency.toUpperCase() !== currency.toUpperCase()
  ) {
    return {
      success: false,
      error_message: STATUS_CODES.CU01,
      error_code: 'CU01',
    };
  }

  if (debitAcc.balance < parsedAmount) {
    return {
      success: false,
      error_message: STATUS_CODES.AC01,
      error_code: 'AC01',
    };
  }

  if (executeBy && !isValidDate(executeBy)) {
    return {
      success: false,
      error_message: STATUS_CODES.DT01,
      error_code: 'DT01',
    };
  }

  return { success: true };
}

/**
 * Execute transaction
 */
function executeTransaction(parsedData, accounts) {
  const {
    amount: rawAmount,
    execute_by: executeBy,
    debit_account: debitAccount,
    credit_account: creditAccount,
  } = parsedData;

  const parsedAmount = Number.parseInt(rawAmount, 10);

  const shouldExecuteNow = !executeBy || isDateInPastOrToday(executeBy);

  if (shouldExecuteNow) {
    const updatedAccounts = accounts.map((acc) => {
      if (acc.id === debitAccount) {
        return {
          ...acc,
          balance_before: acc.balance,
          balance: acc.balance - parsedAmount,
          currency: acc.currency.toUpperCase(),
        };
      }
      if (acc.id === creditAccount) {
        return {
          ...acc,
          balance_before: acc.balance,
          balance: acc.balance + parsedAmount,
          currency: acc.currency.toUpperCase(),
        };
      }
      return {
        ...acc,
        balance_before: acc.balance,
        currency: acc.currency.toUpperCase(),
      };
    });

    return {
      status: 'successful',
      status_reason: STATUS_CODES.AP00,
      status_code: 'AP00',
      accounts: createAccountsResponse(updatedAccounts, debitAccount, creditAccount, true),
    };
  }

  return {
    status: 'pending',
    status_reason: STATUS_CODES.AP02,
    status_code: 'AP02',
    accounts: createAccountsResponse(accounts, debitAccount, creditAccount, false),
  };
}

/**
 * Parse payment instruction using string manipulation only (no regex)
 */
function parseInstruction(instruction) {
  try {
    if (!instruction || typeof instruction !== 'string') {
      return {
        success: false,
        error_message: STATUS_CODES.SY03,
        error_code: 'SY03',
        type: null,
        amount: null,
        currency: null,
        debit_account: null,
        credit_account: null,
        execute_by: null,
      };
    }

    const normalized = instruction.trim().replace(/\s+/g, ' ').toUpperCase();
    const parts = normalized.split(' ');

    if (parts.length < 8) {
      return {
        success: false,
        error_message: STATUS_CODES.SY03,
        error_code: 'SY03',
        type: null,
        amount: null,
        currency: null,
        debit_account: null,
        credit_account: null,
        execute_by: null,
      };
    }

    let type;
    let data;

    if (parts[0] === 'DEBIT') {
      type = 'DEBIT';
      const debitResult = parseDebitInstruction(parts, instruction);
      if (!debitResult.success) {
        return debitResult;
      }
      data = debitResult.data;
    } else if (parts[0] === 'CREDIT') {
      type = 'CREDIT';
      const creditResult = parseCreditInstruction(parts, instruction);
      if (!creditResult.success) {
        return creditResult;
      }
      data = creditResult.data;
    } else {
      return {
        success: false,
        error_message: STATUS_CODES.SY01,
        error_code: 'SY01',
        type: null,
        amount: null,
        currency: null,
        debit_account: null,
        credit_account: null,
        execute_by: null,
      };
    }

    return {
      success: true,
      data: {
        type,
        amount: data.amount,
        currency: data.currency,
        debit_account: data.debit_account,
        credit_account: data.credit_account,
        execute_by: data.execute_by,
      },
    };
  } catch (error) {
    return {
      success: false,
      error_message: STATUS_CODES.SY03,
      error_code: 'SY03',
      type: null,
      amount: null,
      currency: null,
      debit_account: null,
      credit_account: null,
      execute_by: null,
    };
  }
}

async function paymentInstructionService(payload) {
  try {
    if (!payload || !payload.accounts || !payload.instruction) {
      return createErrorResponse(
        null,
        null,
        null,
        null,
        null,
        null,
        'failed',
        STATUS_CODES.SY03,
        'SY03',
        []
      );
    }

    const parseResult = parseInstruction(payload.instruction);

    if (!parseResult.success) {
      return createErrorResponse(
        parseResult.type,
        parseResult.amount,
        parseResult.currency,
        parseResult.debit_account,
        parseResult.credit_account,
        parseResult.execute_by,
        'failed',
        parseResult.error_message,
        parseResult.error_code,
        []
      );
    }

    const validationResult = validateBusinessRules(parseResult.data, payload.accounts);

    if (!validationResult.success) {
      const {
        type,
        amount,
        currency,
        debit_account: debitAccount,
        credit_account: creditAccount,
        execute_by: executeBy,
      } = parseResult.data;

      return createErrorResponse(
        type,
        amount,
        currency,
        debitAccount,
        creditAccount,
        executeBy,
        'failed',
        validationResult.error_message,
        validationResult.error_code,
        createAccountsResponse(payload.accounts, debitAccount, creditAccount, false)
      );
    }

    const executionResult = executeTransaction(parseResult.data, payload.accounts);

    return createSuccessResponse(
      parseResult.data,
      executionResult.status,
      executionResult.status_reason,
      executionResult.status_code,
      executionResult.accounts
    );
  } catch (error) {
    appLogger.error({ error }, 'payment-instruction-service-unexpected-error');
    return createErrorResponse(
      null,
      null,
      null,
      null,
      null,
      null,
      'failed',
      STATUS_CODES.SY03,
      'SY03',
      []
    );
  }
}

module.exports = paymentInstructionService;
