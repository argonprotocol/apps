<!-- prettier-ignore -->
<template>
  <div @focus="handleFocus" @blur="handleBlur" ref="$el" :class="[[props.class || '', hasFocus ? 'z-90' : ''].join(' ')]" class="relative focus-within:relative focus:outline-none" tabindex="0">
    <div
      InputFieldWrapper
      :class="twMerge(
        props.disabled ? 'border-dashed' : '',
        hasFocus ? 'inner-input-shadow outline-2 -outline-offset-2 outline-argon-button' : '',
        !hasFocus && !props.disabled ? 'hover:bg-white' : '',
        'min-w-20 font-mono text-sm flex flex-row w-full text-left py-[2px] border border-slate-700/50 rounded-md text-gray-800 cursor-text',
      )"
    >
      <span class="select-none pl-[10px] py-[1px]">{{ prefix }}</span>
      <div class="relative inline-block w-auto whitespace-nowrap">
        <div :class="[!inputValueInserted || currentInputValueFormatted.startsWith(inputValueInserted) ? 'opacity-50' : 'opacity-0']" class="inline-block w-auto py-[1px] min-w-1">{{ currentInputValueFormatted }}</div>
        <div
          data-testid="input-number"
          :contenteditable="!props.disabled"
          ref="inputElem"
          @focus="handleFocus"
          @blur="handleBlur"
          @input="handleInput"
          @beforeinput="handleBeforeInput($event as InputEvent)"
          @paste="handlePaste($event as ClipboardEvent)"
          @keydown.capture="handleKeyDown($event)"
          :class="[props.disabled ? 'opacity-70' : '']"
          class="absolute top-0 right-0 w-full h-full focus:outline-none py-[1px] min-w-1"
        ></div>
      </div>
      <span Suffix :class="[props.disabled ? 'pointer-events-none' : '', suffix[0] === ' ' ? 'pl-[6px]' : 'pl-[2px]']" class="grow opacity-50 select-none pr-2 min-w-4 relative cursor-text py-[1px]">
        <span v-if="suffix" class="inline-block">{{ suffix }}</span>
        <span @click="moveCursorToEnd" @dblclick="selectAllText" class="absolute top-0 left-0 w-full h-full" />
      </span>

      <div NumArrows v-if="!props.disabled" class="flex flex-col mr-2">
        <tooltip side="top" content="Click or drag">
          <NumArrow NumArrowUp
            @pointerdown="handlePointerDown"
            @pointerup="handlePointerUp"
            @pointermove="emitDrag"
            @pointercancel="handlePointerUp"
            class="relative top-[1px] size-[12px] text-gray-300 cursor-pointer hover:text-gray-600"
          />
        </tooltip>
        <tooltip side="bottom" content="Click or drag">
          <NumArrow NumArrowDown
            @pointerdown="handlePointerDown"
            @pointerup="handlePointerUp"
            @pointermove="emitDrag"
            @pointercancel="handlePointerUp"
            class="relative top-[-1px] size-[12px] text-gray-300 rotate-180 cursor-pointer hover:text-gray-600"
          />
        </tooltip>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import NumArrow from '../assets/num-arrow.svg?component';
import numeral from '../lib/numeral';
import Tooltip from './Tooltip.vue';
import { twMerge } from 'tailwind-merge';

const props = withDefaults(
  defineProps<{
    modelValue: number;
    max?: number;
    min?: number;
    dragBy?: number;
    dragByMin?: number;
    disabled?: boolean;
    prefix?: string;
    suffix?: string;
    minDecimals?: number;
    maxDecimals?: number;
    format?: 'percent' | 'number' | 'minutes';
    class?: string;
  }>(),
  {
    dragBy: 1,
    dragByMin: 0.01,
    prefix: '',
    suffix: '',
    disabled: false,
    format: 'number',
    minDecimals: 0,
    maxDecimals: 2,
  },
);

let currentInputValue = props.modelValue;
let lastValueBeforeMinIncrease = currentInputValue;

const currentInputValueFormatted = Vue.ref(formatFn(currentInputValue));
const inputValueInserted = Vue.ref('');

const emit = defineEmits<{
  (e: 'input', value: number): void;
  (e: 'change', value: number): void;
  (e: 'update:modelValue', value: number): void;
}>();

const $el = Vue.ref<HTMLElement | null>(null);
const inputElem = Vue.ref<HTMLInputElement | null>(null);
const hasFocus = Vue.ref(false);

let incrementTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;
let incrementIntervalId: ReturnType<typeof setInterval> | undefined = undefined;
let decrementTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;
let decrementIntervalId: ReturnType<typeof setInterval> | undefined = undefined;
let minMaxInputValueTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

// Add this after other module-level variables
let pendingCaretPosition: number | null = null;

// Configuration for continuous increment/decrement
const initialDelay = 500; // Initial delay before starting continuous updates
const updateInterval = 50; // Interval between updates once continuous mode starts

const suffix = Vue.computed(() => {
  let sfx = '';
  if (props.format === 'percent') {
    sfx = '%';
  } else if (props.format === 'minutes') {
    sfx = currentInputValue === 1 ? ' minute' : ' minutes';
  }

  if (props.suffix) {
    sfx += props.suffix;
  }

  return sfx;
});

function updateInputValue(
  inputValue: number,
  isManualInput: boolean,
  setAsLastValueBeforeMinIncrease: boolean = false,
) {
  const boundedInputValue = calculateBoundedInputValue(inputValue);
  currentInputValue = inputValue;

  if (minMaxInputValueTimeoutId) {
    clearTimeout(minMaxInputValueTimeoutId);
  }
  minMaxInputValueTimeoutId = undefined;

  if (setAsLastValueBeforeMinIncrease) {
    lastValueBeforeMinIncrease = inputValue;
  }

  if (boundedInputValue !== inputValue) {
    minMaxInputValueTimeoutId = setTimeout(() => {
      if (inputValue !== currentInputValue) return;
      updateInputValue(boundedInputValue, isManualInput);
    }, 1_000);
  }

  emit('update:modelValue', boundedInputValue);
  emit('change', boundedInputValue);
  if (isManualInput) {
    emit('input', boundedInputValue);
  }
  insertIntoInputElem(inputValue);
}

function calculateBoundedInputValue(inputValue: number) {
  if (props.max !== undefined && inputValue > props.max) {
    inputValue = props.max;
  }
  if (props.min !== undefined && inputValue < props.min) {
    inputValue = props.min;
  }
  return inputValue;
}

function insertIntoInputElem(rawValue: number) {
  if (!inputElem.value) return;

  const hasFocus = document.activeElement === inputElem.value;
  const oldValue = inputElem.value.textContent || '';
  const newValue = formatFn(rawValue);

  inputValueInserted.value = newValue;
  currentInputValueFormatted.value = formatFn(currentInputValue);

  if (oldValue === newValue) {
    return;
  }

  const oldCaretPosition = hasFocus ? getCaretPosition().end : 0;

  if (hasFocus) {
    // Use execCommand to preserve undo/redo stack
    const selection = window.getSelection();
    if (selection) {
      // Select all content
      const range = document.createRange();
      range.selectNodeContents(inputElem.value);
      selection.removeAllRanges();
      selection.addRange(range);

      // Insert the new text (this creates undo history)
      document.execCommand('insertText', false, newValue);

      // Set caret position
      let newCaretPosition;
      if (pendingCaretPosition !== null) {
        newCaretPosition = pendingCaretPosition;
        pendingCaretPosition = null;
      } else {
        newCaretPosition = calculateAdjustedCaretPosition(oldValue, newValue, oldCaretPosition);
      }
      setCaretPosition(newCaretPosition);
    }
  } else {
    // If not focused, just set the content directly
    inputElem.value.textContent = newValue;
  }
}

function calculateAdjustedCaretPosition(oldText: string, newText: string, oldPosition: number): number {
  // If the cursor was at the end of the old text, keep it at the end of the new text
  if (oldPosition >= oldText.length) {
    return newText.length;
  }

  // Count numeric characters (digits and decimal points) up to the old position
  let numericCharsBeforeOldPosition = 0;
  for (let i = 0; i < Math.min(oldPosition, oldText.length); i++) {
    if (/[\d.]/.test(oldText[i])) {
      numericCharsBeforeOldPosition++;
    }
  }

  // Find the position in the new text that corresponds to the same number of numeric characters
  let numericCharsFound = 0;
  for (let i = 0; i < newText.length; i++) {
    if (/[\d.]/.test(newText[i])) {
      numericCharsFound++;
      if (numericCharsFound > numericCharsBeforeOldPosition) {
        return i;
      }
    }
  }

  // If we haven't found enough numeric characters, position at the end
  return newText.length;
}

function formatFn(value: number) {
  let decimalCount = value.toString().split('.')[1]?.length || 0;
  decimalCount = Math.min(decimalCount, props.maxDecimals);
  decimalCount = Math.max(decimalCount, props.minDecimals);
  const decimals = ''.padEnd(decimalCount, '0');
  return numeral(value).formatIfElse(!!decimals, `0,0.${decimals}`, '0,0');
}

function moveCursorToEnd() {
  inputElem.value?.focus();
  const range = document.createRange();
  const selection = window.getSelection();
  if (inputElem.value?.firstChild) {
    range.setStartAfter(inputElem.value.firstChild);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}
function handleFocus() {
  if (props.disabled) return;

  // Check if focus is coming from a text selection
  const selection = window.getSelection();
  if (selection && selection.toString().length > 0) {
    return;
  }

  hasFocus.value = true;
}

function handleBlur() {
  const activeElement = document.activeElement;
  const activeElementIsOther = !activeElement || !$el.value?.contains(activeElement);
  if (activeElementIsOther) {
    hasFocus.value = false;
    const boundedInputValue = calculateBoundedInputValue(currentInputValue);
    updateInputValue(boundedInputValue, true);
  }
}

let startDragY: number | null = null;
let startValue: number = currentInputValue;
let isDragging = false;
let minStepsUp: number = 0;
let minStepsDown: number = 0;
let stepsDownUntilDragBy: number = 0;
let startPointerX: number | null = null;
let startPointerY: number | null = null;
let isContinuousMode = false;
let continuousTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

function handlePointerDown(event: PointerEvent) {
  const button = event.currentTarget as HTMLButtonElement;
  if (!button) return;

  // Only allow focus if it's a click (not a drag)
  if (event.pointerType === 'mouse') {
    const isClick = event.buttons === 1 && !event.isPrimary;
    if (!isClick) {
      event.preventDefault();
    }
  }

  button.setPointerCapture(event.pointerId);
  startDragY = event.clientY;
  startValue = currentInputValue;
  startPointerX = event.clientX;
  startPointerY = event.clientY;
  isContinuousMode = false;

  // Calculate steps needed to reach nearest integers
  if (startValue % 1 !== 0) {
    const minStep = props.dragByMin || props.dragBy;
    const nextIntegerUp = Math.ceil(startValue);
    const nextIntegerDown = Math.floor(startValue);

    minStepsUp = Math.round((nextIntegerUp - startValue) / minStep);
    minStepsDown = Math.round((startValue - nextIntegerDown) / minStep);
  } else {
    minStepsUp = 0;
    minStepsDown = 0;
  }

  // Calculate steps needed to reach dragBy
  if (startValue > props.dragBy) {
    stepsDownUntilDragBy = Math.floor(startValue) - props.dragBy;
  } else {
    stepsDownUntilDragBy = 0;
  }

  // Start a timer to check if we should enter continuous mode
  continuousTimeoutId = setTimeout(() => {
    if (startPointerX !== null && startPointerY !== null && !isDragging) {
      isContinuousMode = true;
      // Determine which arrow was clicked and start appropriate continuous function
      const isUpArrow = button.classList.contains('rotate-180') === false;
      if (isUpArrow) {
        startContinuousIncrement();
      } else {
        startContinuousDecrement();
      }
    }
  }, 500); // 500ms delay before starting continuous mode
}

function emitDrag(event: PointerEvent) {
  if (startDragY === null || startPointerX === null || startPointerY === null) return;

  const currentY = event.clientY;
  const currentX = event.clientX;
  const deltaY = startDragY - currentY; // Inverted to make dragging up increase value
  const deltaX = currentX - startPointerX;

  // Check if movement is more than 3 pixels in any direction
  const totalMovement = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

  if (totalMovement > 3) {
    // Cancel continuous mode if we're moving significantly
    if (continuousTimeoutId !== undefined) {
      clearTimeout(continuousTimeoutId);
      continuousTimeoutId = undefined;
    }
    if (isContinuousMode) {
      stopContinuousUpdates();
      isContinuousMode = false;
    }

    // Enter drag mode
    isDragging = true;

    const direction = Math.sign(deltaY);
    const totalSteps = Math.abs(deltaY);

    let newValue = startValue;
    let remainingSteps = totalSteps;

    const minStep = props.dragByMin || props.dragBy;
    const stepsToInteger = direction > 0 ? minStepsUp : minStepsDown;

    if (remainingSteps <= stepsToInteger) {
      // Still in decimal territory, use min steps
      newValue += direction * remainingSteps * minStep;
      remainingSteps = 0;
    } else {
      // Cross into integer territory
      newValue += direction * stepsToInteger * minStep;
      remainingSteps -= stepsToInteger;
    }

    let remainingSmallSteps = 0;
    // Handle remaining steps with normal step size
    if (direction < 0 && remainingSteps > stepsDownUntilDragBy) {
      remainingSmallSteps = remainingSteps - stepsDownUntilDragBy;
      remainingSteps = stepsDownUntilDragBy;
    }

    if (remainingSteps) {
      let stepSize = props.dragBy;
      newValue += direction * remainingSteps * stepSize;
    }

    if (remainingSmallSteps) {
      let stepSize = props.dragByMin || props.dragBy;
      newValue += direction * remainingSmallSteps * stepSize;
    }

    // Apply min/max constraints
    newValue = calculateBoundedInputValue(newValue);

    // Update visual feedback
    if (newValue > currentInputValue) {
      document.body.classList.add('isDraggingIncrease');
      document.body.classList.remove('isDraggingDecrease');
    } else if (newValue < currentInputValue) {
      document.body.classList.add('isDraggingDecrease');
      document.body.classList.remove('isDraggingIncrease');
    }

    if (newValue !== currentInputValue) {
      updateInputValue(newValue, true, true);
    }
  }
}

function handlePointerUp(event: PointerEvent) {
  const button = event.currentTarget as HTMLButtonElement;
  if (!button) return;

  button.releasePointerCapture(event.pointerId);
  document.body.classList.remove('isDraggingIncrease');
  document.body.classList.remove('isDraggingDecrease');

  // Clear continuous timer
  if (continuousTimeoutId !== undefined) {
    clearTimeout(continuousTimeoutId);
    continuousTimeoutId = undefined;
  }

  // Stop continuous updates if active
  if (isContinuousMode) {
    stopContinuousUpdates();
    isContinuousMode = false;
  }

  // If we didn't drag and didn't enter continuous mode, do a single increment/decrement
  if (!isDragging && !isContinuousMode && startPointerX !== null && startPointerY !== null) {
    const isUpArrow = button.classList.contains('rotate-180') === false;
    if (isUpArrow) {
      incrementValue();
    } else {
      decrementValue();
    }
  }

  startDragY = null;
  startPointerX = null;
  startPointerY = null;
  setTimeout(() => {
    isDragging = false;
  }, 100);
}

function handlePaste(event: ClipboardEvent) {
  event.preventDefault();
  const pastedText = event.clipboardData?.getData('text') || '';
  const sanitizedText = pastedText.replace(/[^\d,.]/g, '');

  const target = event.target as HTMLElement;
  if (!target) return;

  // Get current selection and cursor position
  const selection = window.getSelection();
  const range = selection?.getRangeAt(0);

  if (!selection || !range) return;

  // Get the start and end positions of the selection
  const startOffset = range.startOffset;
  const endOffset = range.endOffset;
  const hasSelection = startOffset !== endOffset;

  // Get the current text content
  const currentText = target.textContent || '';

  let newText: string;
  let newCursorPos: number;

  if (hasSelection) {
    // Replace the selected text with the pasted text
    newText = currentText.slice(0, startOffset) + sanitizedText + currentText.slice(endOffset);
    newCursorPos = startOffset + sanitizedText.length;
  } else {
    // Insert at cursor position (no selection)
    newText = currentText.slice(0, startOffset) + sanitizedText + currentText.slice(startOffset);
    newCursorPos = startOffset + sanitizedText.length;
  }

  // Ensure only one decimal point
  const parts = newText.split('.');
  const finalValue = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : newText;

  // Set the pending caret position to after the pasted text (in terms of numeric chars)
  // We'll use this in insertIntoInputElem after formatting
  const numericValue = Number(finalValue.replace(/,/g, ''));
  const formatted = formatFn(numericValue);

  // Calculate the caret position
  let calculatedCaretPosition: number;
  // If the paste was at the end of the input, set caret to the end
  if (newCursorPos >= finalValue.length) {
    calculatedCaretPosition = formatted.length;
  } else {
    // Otherwise, count numeric chars up to newCursorPos in the unformatted string
    let numericChars = 0;
    for (let i = 0; i < Math.min(newCursorPos, finalValue.length); i++) {
      if (/\d|\./.test(finalValue[i])) numericChars++;
    }
    // Now, find the position in the formatted string after the same number of numeric chars
    let found = 0;
    calculatedCaretPosition = formatted.length; // Default to end
    for (let i = 0; i < formatted.length; i++) {
      if (/\d|\./.test(formatted[i])) {
        found++;
        if (found === numericChars) {
          // Place caret after the last pasted char
          calculatedCaretPosition = i + 1;
          break;
        }
      }
    }
  }

  pendingCaretPosition = calculatedCaretPosition;

  if (!isNaN(numericValue)) {
    updateInputValue(numericValue, true, true);
  }
}

function handleBeforeInput(event: InputEvent) {
  if (event.inputType === 'insertText') {
    const caretPosition = getCaretPosition().start;

    const char = event.data;
    if (caretPosition === 0 && char === '-') {
      return;
    } else if (char && !/[\d,.]/.test(char)) {
      event.preventDefault();
    }
  }
}

let updateInputValueTimer: ReturnType<typeof setTimeout> | undefined = undefined;

function handleInput() {
  const currentText = inputElem.value?.textContent || '';
  const inputValue = Number(currentText.replace(/,/g, ''));
  if (isNaN(inputValue)) return;

  const boundedInputValue = calculateBoundedInputValue(inputValue);
  currentInputValue = boundedInputValue;
  currentInputValueFormatted.value = formatFn(inputValue);

  if (inputValue === boundedInputValue) {
    if (updateInputValueTimer) {
      clearTimeout(updateInputValueTimer);
    }
    updateInputValueTimer = setTimeout(() => {
      updateInputValue(boundedInputValue, true, true);
    }, 1e3);
  }

  inputValueInserted.value = currentText;
}

function getCaretPosition(): { start: number; end: number } {
  const selection = window.getSelection();
  if (!selection || !selection.anchorNode || !inputElem.value) return { start: 0, end: 0 };

  const range = selection.getRangeAt(0);
  const preCaretRange = range.cloneRange();
  preCaretRange.selectNodeContents(inputElem.value);

  // Calculate start position
  preCaretRange.setEnd(range.startContainer, range.startOffset);
  const start = preCaretRange.toString().length;

  // Calculate end position
  preCaretRange.setEnd(range.endContainer, range.endOffset);
  const end = preCaretRange.toString().length;

  return { start, end };
}

function setCaretPosition(position: number) {
  if (!inputElem.value) return;

  const selection = window.getSelection();
  const range = document.createRange();
  const textNode = inputElem.value.firstChild || inputElem.value;

  // Ensure position is within bounds
  const maxLength = (inputElem.value.textContent || '').length;
  position = Math.min(Math.max(0, position), maxLength);

  range.setStart(textNode, position);
  range.setEnd(textNode, position);

  selection?.removeAllRanges();
  selection?.addRange(range);
}

function incrementValue() {
  const startValue = currentInputValue;

  let incrementBy = props.dragBy;
  if (startValue < props.dragBy) {
    incrementBy = props.dragByMin || props.dragBy;
  } else if (startValue % 1 !== 0) {
    incrementBy = props.dragByMin || props.dragBy;
  }
  const newValue = BigNumber(startValue).plus(incrementBy).toNumber();
  const boundedValue = calculateBoundedInputValue(newValue);

  updateInputValue(boundedValue, true);
}

function decrementValue() {
  const startValue = currentInputValue;

  let decrementBy = props.dragBy;
  if (startValue <= props.dragBy) {
    decrementBy = props.dragByMin || props.dragBy;
  } else if (startValue % 1 !== 0) {
    decrementBy = props.dragByMin || props.dragBy;
  }
  const newValue = BigNumber(startValue).minus(decrementBy).toNumber();
  const boundedValue = calculateBoundedInputValue(newValue);

  updateInputValue(boundedValue, true);
}

function startContinuousIncrement() {
  stopContinuousUpdates();
  incrementValue();

  incrementTimeoutId = setTimeout(() => {
    incrementIntervalId = setInterval(() => {
      incrementValue();
    }, updateInterval);
    incrementTimeoutId = undefined;
  }, initialDelay);
}

function startContinuousDecrement() {
  try {
    stopContinuousUpdates();
    decrementValue();

    decrementTimeoutId = setTimeout(() => {
      decrementIntervalId = setInterval(() => {
        decrementValue();
      }, updateInterval);
      decrementTimeoutId = undefined;
    }, initialDelay);
  } catch (error) {
    console.error('Error starting continuous decrement:', error);
  }
}

function stopContinuousUpdates() {
  if (incrementTimeoutId !== undefined) {
    clearTimeout(incrementTimeoutId);
    incrementTimeoutId = undefined;
  }
  if (incrementIntervalId !== undefined) {
    clearInterval(incrementIntervalId);
    incrementIntervalId = undefined;
  }
  if (decrementTimeoutId !== undefined) {
    clearTimeout(decrementTimeoutId);
    decrementTimeoutId = undefined;
  }
  if (decrementIntervalId !== undefined) {
    clearInterval(decrementIntervalId);
    decrementIntervalId = undefined;
  }
  if (continuousTimeoutId !== undefined) {
    clearTimeout(continuousTimeoutId);
    continuousTimeoutId = undefined;
  }
}

function handleKeyDown(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (!target) return;

  if ((event.metaKey || event.ctrlKey) && (event.key === 'z' || event.key === 'y')) {
    // Allow undo/redo shortcuts to work
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    decrementValue();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    incrementValue();
  } else if (event.key === 'Enter') {
    event.preventDefault();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    inputElem.value?.blur();
  }
}

function selectAllText() {
  if (!inputElem.value) return;

  const range = document.createRange();
  range.selectNodeContents(inputElem.value);
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function handleClickOutside(event: MouseEvent) {
  const isOutsideClick = $el.value && !$el.value.contains(event.target as Node);
  if (isOutsideClick) {
    inputElem.value?.blur();
  }
}

Vue.watch(
  () => props.modelValue,
  (x: number) => {
    if (x !== currentInputValue) {
      updateInputValue(x, false);
    }
  },
);

Vue.watch(
  () => props.min,
  newMin => {
    const newMinValue = Number(newMin);
    if (newMinValue === undefined) return;

    if (currentInputValue < newMinValue) {
      lastValueBeforeMinIncrease = Math.min(currentInputValue, lastValueBeforeMinIncrease);
      updateInputValue(newMinValue, false);
    } else if (currentInputValue > newMinValue && currentInputValue > lastValueBeforeMinIncrease) {
      updateInputValue(Math.max(newMinValue, lastValueBeforeMinIncrease), false);
    }
  },
  { immediate: true },
);

Vue.onMounted(() => {
  insertIntoInputElem(currentInputValue);
});

// Add click outside handler
Vue.onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

Vue.onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside);
});
</script>
