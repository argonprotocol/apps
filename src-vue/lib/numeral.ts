import * as Vue from 'vue';
import numeralOriginal, { Numeral } from 'numeral';
import { Currency, UnitOfMeasurement } from './Currency';

// Extend the Numeral interface to include our custom method
declare module 'numeral' {
  interface Numeral {
    formatIfElse(condition: ICondition, ifFormat: string, elseFormat: string): string;
    formatIfElseCapped(condition: ICondition, ifFormat: string, elseFormat: string, max: number): string;
    formatCapped(format: string, max: number): string;
    _value: number;
  }
}

export { Numeral } from 'numeral';

type ICondition = boolean | string | ((value: number) => boolean);

export default function numeral(input?: any): Numeral {
  if (typeof input === 'bigint') {
    input = Number(input);
  }
  return numeralOriginal(input);
}

numeralOriginal.fn.formatIfElse = function (condition: ICondition, ifFormat: string, elseFormat: string) {
  const format = chooseIfElseFormat(condition, ifFormat, elseFormat, this._value);
  return this.format(format);
};

numeralOriginal.fn.formatCapped = function (format: string, max: number) {
  if (this._value > max) {
    this._value = max;
    if (format.includes('%')) {
      format = format.replace('%', '+%');
    } else {
      format += '+';
    }
  }

  return this.format(format);
};

numeralOriginal.fn.formatIfElseCapped = function (
  condition: ICondition,
  ifFormat: string,
  elseFormat: string,
  max: number,
) {
  let format = chooseIfElseFormat(condition, ifFormat, elseFormat, this._value);

  if (this._value > max) {
    this._value = max;
    format += '+';
  }

  return this.format(format);
};

export function createNumeralHelpers(currency: Currency | Vue.Reactive<Currency>) {
  return {
    microgonToMoneyNm(this: void, microgons: bigint): Numeral {
      return numeral(currency.convertMicrogonTo(microgons, currency.key));
    },
    microgonToArgonNm(this: void, microgons: bigint): Numeral {
      return numeral(currency.convertMicrogonTo(microgons, UnitOfMeasurement.ARGN));
    },
    microgonToBtcNm(this: void, microgons: bigint): Numeral {
      return numeral(currency.convertMicrogonTo(microgons, UnitOfMeasurement.BTC));
    },
    microgonToNm(this: void, microgons: bigint, to: UnitOfMeasurement): Numeral {
      return numeral(currency.convertMicrogonTo(microgons, to));
    },

    micronotToMoneyNm(this: void, micronots: bigint): Numeral {
      return numeral(currency.convertMicronotTo(micronots, currency.key));
    },
    micronotToArgonNm(this: void, micronots: bigint): Numeral {
      return numeral(currency.convertMicronotTo(micronots, UnitOfMeasurement.ARGN));
    },
    micronotToArgonotNm(this: void, micronots: bigint): Numeral {
      return numeral(currency.convertMicronotTo(micronots, UnitOfMeasurement.ARGNOT));
    },
  };
}

function chooseIfElseFormat(condition: ICondition, ifFormat: string, elseFormat: string, value: number) {
  if (typeof condition === 'boolean') {
    return condition ? ifFormat : elseFormat;
  }

  if (typeof condition === 'function') {
    return condition(value) ? ifFormat : elseFormat;
  }

  // Parse the condition string, e.g., ">= 1000" or "1000" (defaults to ==)
  const match = condition.match(/((>=|<=|>|<|==|!=)\s*)?([\d,_]+(\.\d+)?)/);
  if (!match) throw new Error('Invalid condition');

  const [, , operator = '==', threshold] = match;
  const thresholdNum = parseFloat(threshold.replace(/[,]/g, '').replace(/_/g, ''));

  let conditionMet = false;
  switch (operator) {
    case '>=':
      conditionMet = value >= thresholdNum;
      break;
    case '<=':
      conditionMet = value <= thresholdNum;
      break;
    case '>':
      conditionMet = value > thresholdNum;
      break;
    case '<':
      conditionMet = value < thresholdNum;
      break;
    case '==':
      conditionMet = value == thresholdNum;
      break;
    case '!=':
      conditionMet = value != thresholdNum;
      break;
  }
  return conditionMet ? ifFormat : elseFormat;
}
