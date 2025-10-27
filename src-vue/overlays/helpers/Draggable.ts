import * as Vue from 'vue';

export default class Draggable {
  public modalPosition: { x: number; y: number };
  public isDragging: boolean;
  public dragStart: { x: number; y: number };
  public mouseStart: { x: number; y: number };
  public modalRef: Element | Vue.ComponentPublicInstance | null;

  constructor() {
    this.modalPosition = Vue.reactive({ x: 0, y: 0 });
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.mouseStart = { x: 0, y: 0 };
    this.modalRef = null;

    // Bind setModalRef to this to ensure proper context when used as a callback
    this.setModalRef = this.setModalRef.bind(this);
  }

  public setModalRef(el: Element | Vue.ComponentPublicInstance | null) {
    this.modalRef = el;
  }

  public onMouseDown(event: MouseEvent) {
    if (!this.modalRef) {
      console.error('Draggable: modalRef is not set');
      return;
    }
    this.isDragging = true;
    this.mouseStart = { x: event.clientX, y: event.clientY };
    this.dragStart = { ...this.modalPosition };
    window.addEventListener('mousemove', this.onDragMove.bind(this));
    window.addEventListener('mouseup', this.onDragEnd.bind(this));
  }

  private onDragMove(e: MouseEvent) {
    if (!this.isDragging) return;
    console.log('onDragMove', `isDragging = ${this.isDragging}`);

    const dx = e.clientX - this.mouseStart.x;
    const dy = e.clientY - this.mouseStart.y;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let newX = this.dragStart.x + dx;
    let newY = this.dragStart.y + dy;

    const modalElem: HTMLElement | null = (this.modalRef as any)?.$el || this.modalRef;

    if (modalElem) {
      const rect = modalElem.getBoundingClientRect();
      const modalWidth = rect.width;
      const modalHeight = rect.height;

      // The max offset from center so that the edge doesn't go outside the viewport, with padding
      const padding = 10;
      const maxOffsetX = (vw - modalWidth) / 2 - padding;
      const maxOffsetY = (vh - modalHeight) / 2 - padding;

      newX = Math.max(-maxOffsetX, Math.min(maxOffsetX, newX));
      newY = Math.max(-maxOffsetY, Math.min(maxOffsetY, newY));
    }

    this.modalPosition.x = newX;
    this.modalPosition.y = newY;
  }

  private onDragEnd() {
    this.isDragging = false;
    console.log('onDragEnd', `isDragging = ${this.isDragging}`);
    window.removeEventListener('mousemove', this.onDragMove.bind(this));
    window.removeEventListener('mouseup', this.onDragEnd.bind(this));
  }
}
