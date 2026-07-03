// Single-slider Liquid Glass shader for the model tabs.
// The five buttons stay clean; one moving .model-tab-glass owns the filter.
(function () {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  const XLINK = "http://www.w3.org/1999/xlink";
  const TABS_SELECTOR = "#modelTabs";
  const GLASS_SELECTOR = ".model-tab-glass";
  const BUTTON_SELECTOR = "button[data-model-id]";
  const MAX_SHADER_PIXELS = 26000;
  const LENS_OUTSET = 8;
  const LENS_EXPANSION = LENS_OUTSET * 2;
  let sliderBinding = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function smoothStep(a, b, t) {
    const value = clamp((t - a) / (b - a), 0, 1);
    return value * value * (3 - 2 * value);
  }

  function length(x, y) {
    return Math.sqrt(x * x + y * y);
  }

  function roundedRectSDF(x, y, halfWidth, halfHeight, radius) {
    const qx = Math.abs(x) - halfWidth + radius;
    const qy = Math.abs(y) - halfHeight + radius;
    return Math.min(Math.max(qx, qy), 0) + length(Math.max(qx, 0), Math.max(qy, 0)) - radius;
  }

  function generateId() {
    return `liquid-slider-${Math.random().toString(36).slice(2, 11)}`;
  }

  function canvasDPIFor(width, height, padding) {
    const pixels = (width + padding * 2) * (height + padding * 2);
    if (pixels <= MAX_SHADER_PIXELS) return 1;
    return clamp(Math.sqrt(MAX_SHADER_PIXELS / pixels), 0.42, 1);
  }

  function liquidSliderFragment(uv, mouse, uniforms) {
    const aspect = uniforms.aspect || 1;
    const px = (uv.x - 0.5) * aspect;
    const py = uv.y - 0.5;
    const mx = (clamp(mouse.x, 0, 1) - 0.5) * aspect;
    const my = clamp(mouse.y, 0, 1) - 0.5;

    const halfWidth = Math.max(0.05, aspect * 0.5 - 0.055);
    const halfHeight = Math.max(0.05, 0.5 - 0.055);
    const radius = Math.min(halfHeight * 0.96, halfWidth);
    const d = roundedRectSDF(px, py, halfWidth, halfHeight, radius);

    // Center is deliberately neutral. Only the inner edge and the outside shell
    // generate displacement, which avoids the hard inner ring/double-image bug.
    const innerRim = smoothStep(-0.34, -0.018, d);
    const outerRim = 1 - smoothStep(0.0, 0.96, d);
    const edgeField = d < 0 ? innerRim : outerRim;
    const outsideBias = smoothStep(-0.035, 0.84, d);
    const rim = clamp(edgeField, 0, 1);

    const epsilon = 0.0022;
    const sdfRight = roundedRectSDF(px + epsilon, py, halfWidth, halfHeight, radius);
    const sdfLeft = roundedRectSDF(px - epsilon, py, halfWidth, halfHeight, radius);
    const sdfDown = roundedRectSDF(px, py + epsilon, halfWidth, halfHeight, radius);
    const sdfUp = roundedRectSDF(px, py - epsilon, halfWidth, halfHeight, radius);
    const gx = sdfRight - sdfLeft;
    const gy = sdfDown - sdfUp;
    const normalLength = Math.max(0.0001, length(gx, gy));
    const nx = gx / normalLength;
    const ny = gy / normalLength;
    const tx = -ny;
    const ty = nx;

    const dx = px - mx;
    const dy = py - my;
    const pointerDistance = length(dx / Math.max(aspect, 1), dy);
    const pointerWake = smoothStep(0.72, 0.0, pointerDistance) * rim;
    const ripple = Math.sin((dx * 8.5 + dy * 4.2) * Math.PI) * pointerWake;

    const outwardBend = rim * (0.115 + outsideBias * 0.21);
    const pointerBend = pointerWake * 0.016;
    const rippleBend = ripple * 0.007;

    return {
      x: uv.x + (nx * outwardBend + dx * pointerBend + tx * rippleBend) / aspect,
      y: uv.y + ny * outwardBend + dy * pointerBend + ty * rippleBend
    };
  }

  class ShaderMap {
    constructor(target) {
      this.target = target;
      this.id = generateId();
      this.width = Math.max(1, Math.round(target?.offsetWidth || 120));
      this.height = Math.max(1, Math.round(target?.offsetHeight || 40));
      this.padding = this.paddingFor(this.width, this.height);
      this.canvasDPI = canvasDPIFor(this.width, this.height, this.padding);
      this.scaleMultiplier = 4.575;
      this.mouse = { x: 0.5, y: 0.5 };
      this.createElements();
      this.setSize(this.width, this.height);
      this.updateShader();
    }

    paddingFor(width, height) {
      return Math.max(128, Math.round(Math.max(width, height) * 0.88), Math.round(height * 2.88));
    }

    createElements() {
      this.svg = document.createElementNS(SVG, "svg");
      this.svg.setAttribute("xmlns", SVG);
      this.svg.setAttribute("width", "0");
      this.svg.setAttribute("height", "0");
      this.svg.setAttribute("aria-hidden", "true");
      this.svg.setAttribute("focusable", "false");
      this.svg.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;pointer-events:none;";

      const defs = document.createElementNS(SVG, "defs");
      this.filter = document.createElementNS(SVG, "filter");
      this.filter.setAttribute("id", `${this.id}_filter`);
      this.filter.setAttribute("filterUnits", "userSpaceOnUse");
      this.filter.setAttribute("colorInterpolationFilters", "sRGB");
      this.filter.setAttribute("color-interpolation-filters", "sRGB");

      this.feImage = document.createElementNS(SVG, "feImage");
      this.feImage.setAttribute("id", `${this.id}_map`);
      this.feImage.setAttribute("result", `${this.id}_map`);
      this.feImage.setAttribute("preserveAspectRatio", "none");

      this.feDisplacementMap = document.createElementNS(SVG, "feDisplacementMap");
      this.feDisplacementMap.setAttribute("in", "SourceGraphic");
      this.feDisplacementMap.setAttribute("in2", `${this.id}_map`);
      this.feDisplacementMap.setAttribute("xChannelSelector", "R");
      this.feDisplacementMap.setAttribute("yChannelSelector", "G");

      this.filter.appendChild(this.feImage);
      this.filter.appendChild(this.feDisplacementMap);
      defs.appendChild(this.filter);
      this.svg.appendChild(defs);
      document.body.appendChild(this.svg);

      this.canvas = document.createElement("canvas");
      this.canvas.style.display = "none";
      this.context = this.canvas.getContext("2d", { willReadFrequently: true });
    }

    setSize(width, height) {
      const nextWidth = Math.max(1, Math.round(width));
      const nextHeight = Math.max(1, Math.round(height));
      const nextPadding = this.paddingFor(nextWidth, nextHeight);
      const nextDPI = canvasDPIFor(nextWidth, nextHeight, nextPadding);
      const changed =
        nextWidth !== this.width ||
        nextHeight !== this.height ||
        nextPadding !== this.padding ||
        nextDPI !== this.canvasDPI;

      this.width = nextWidth;
      this.height = nextHeight;
      this.padding = nextPadding;
      this.canvasDPI = nextDPI;

      const regionWidth = this.width + this.padding * 2;
      const regionHeight = this.height + this.padding * 2;
      this.filter.setAttribute("x", String(-this.padding));
      this.filter.setAttribute("y", String(-this.padding));
      this.filter.setAttribute("width", String(regionWidth));
      this.filter.setAttribute("height", String(regionHeight));
      this.feImage.setAttribute("x", String(-this.padding));
      this.feImage.setAttribute("y", String(-this.padding));
      this.feImage.setAttribute("width", String(regionWidth));
      this.feImage.setAttribute("height", String(regionHeight));
      this.canvas.width = Math.max(1, Math.round(regionWidth * this.canvasDPI));
      this.canvas.height = Math.max(1, Math.round(regionHeight * this.canvasDPI));

      if (changed) this.updateShader();
    }

    filterValue() {
      return `url(#${this.id}_filter)`;
    }

    updateShader(mouse = this.mouse) {
      if (!this.context || typeof ImageData === "undefined") return;

      this.mouse.x = clamp(mouse.x, 0, 1);
      this.mouse.y = clamp(mouse.y, 0, 1);

      const w = this.canvas.width;
      const h = this.canvas.height;
      const data = new Uint8ClampedArray(w * h * 4);
      const rawValues = new Float32Array(w * h * 2);
      const uniforms = {
        width: this.width,
        height: this.height,
        aspect: this.width / Math.max(1, this.height)
      };

      let maxScale = 0;
      let vectorIndex = 0;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const regionX = x / this.canvasDPI;
          const regionY = y / this.canvasDPI;
          const localX = regionX - this.padding;
          const localY = regionY - this.padding;
          const uv = {
            x: localX / Math.max(1, this.width),
            y: localY / Math.max(1, this.height)
          };
          const pos = liquidSliderFragment(uv, this.mouse, uniforms);
          const displacedRegionX = pos.x * this.width + this.padding;
          const displacedRegionY = pos.y * this.height + this.padding;
          const dx = displacedRegionX - regionX;
          const dy = displacedRegionY - regionY;
          rawValues[vectorIndex++] = dx;
          rawValues[vectorIndex++] = dy;
          maxScale = Math.max(maxScale, Math.abs(dx), Math.abs(dy));
        }
      }

      maxScale = Math.max(maxScale, 0.001);
      vectorIndex = 0;
      for (let i = 0; i < data.length; i += 4) {
        const dx = rawValues[vectorIndex++];
        const dy = rawValues[vectorIndex++];
        const isNeutral = Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01;
        const r = isNeutral ? 0.5 : dx / maxScale + 0.5;
        const g = isNeutral ? 0.5 : dy / maxScale + 0.5;
        data[i] = isNeutral ? 128 : Math.round(clamp(r, 0, 1) * 255);
        data[i + 1] = isNeutral ? 128 : Math.round(clamp(g, 0, 1) * 255);
        data[i + 2] = 0;
        data[i + 3] = 255;
      }

      this.context.putImageData(new ImageData(data, w, h), 0, 0);
      const dataUrl = this.canvas.toDataURL("image/png");
      this.feImage.setAttribute("href", dataUrl);
      this.feImage.setAttributeNS(XLINK, "href", dataUrl);
      this.feDisplacementMap.setAttribute("scale", String(maxScale * this.scaleMultiplier));
    }

    destroy() {
      this.svg?.remove();
      this.canvas?.remove();
    }
  }

  class SliderLiquidGlass {
    constructor(tabs) {
      this.tabs = tabs;
      this.glass = tabs.querySelector(GLASS_SELECTOR);
      this.mouse = { x: 0.5, y: 0.5 };
      this.raf = 0;
      this.refreshTimer = 0;
      this.lastLensWidth = "";
      this.lastLensTransform = "";

      if (!this.glass) return;
      this.shader = new ShaderMap(this.glass);
      this.bindEvents();
      this.resizeObserver = new ResizeObserver(() => this.refreshSoon());
      this.resizeObserver.observe(this.tabs);
      this.refresh();
    }

    bindEvents() {
      this.onPointerMove = (event) => {
        const rect = this.glass.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        this.mouse = {
          x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
          y: clamp((event.clientY - rect.top) / rect.height, 0, 1)
        };
        this.requestUpdate();
      };
      this.onPointerLeave = () => {
        this.mouse = { x: 0.5, y: 0.5 };
        this.requestUpdate();
      };

      this.tabs.addEventListener("pointermove", this.onPointerMove, { passive: true });
      this.tabs.addEventListener("pointerleave", this.onPointerLeave, { passive: true });
    }

    isLightTheme() {
      return document.documentElement.dataset.theme !== "dark";
    }

    syncActiveGeometry() {
      if (this.tabs.classList.contains("is-dragging") || this.tabs.classList.contains("is-sliding")) return;
      const active = this.tabs.querySelector(`${BUTTON_SELECTOR}.active`) || this.tabs.querySelector(BUTTON_SELECTOR);
      if (!active) return;

      const previousLeft = Number.parseFloat(this.tabs.style.getPropertyValue("--active-tab-x"));
      const left = active.offsetLeft - this.tabs.scrollLeft;
      const direction = Number.isFinite(previousLeft) && left < previousLeft ? -1 : 1;
      const setTabVar = (name, value) => {
        if (this.tabs.style.getPropertyValue(name) !== value) {
          this.tabs.style.setProperty(name, value);
        }
      };
      setTabVar("--active-tab-x", `${left}px`);
      setTabVar("--active-tab-width", `${active.offsetWidth}px`);
      setTabVar("--active-tab-height", `${active.offsetHeight}px`);
      setTabVar("--active-tab-direction", `${direction}`);

      const lensWidth = `${active.offsetWidth + LENS_EXPANSION}px`;
      const lensTransform = `translate3d(${left - LENS_OUTSET}px, 0, 0)`;
      this.glass.style.setProperty("transition", "none", "important");
      if (this.lastLensWidth !== lensWidth || this.glass.style.getPropertyValue("width") !== lensWidth) {
        this.glass.style.setProperty("width", lensWidth, "important");
        this.lastLensWidth = lensWidth;
      }
      if (this.lastLensTransform !== lensTransform || !this.glass.style.getPropertyValue("transform")) {
        this.glass.style.setProperty("transform", lensTransform, "important");
        this.lastLensTransform = lensTransform;
      }
    }

    refresh() {
      if (!this.tabs.isConnected || !this.glass?.isConnected) {
        this.destroy();
        return;
      }

      cleanupButtonFilters(this.tabs);
      this.syncActiveGeometry();
      this.glass.style.removeProperty("background");
      this.glass.style.removeProperty("background-color");
      this.glass.style.removeProperty("background-image");
      this.glass.style.removeProperty("box-shadow");

      if (!this.isLightTheme()) {
        this.glass.style.removeProperty("--model-slider-liquid-filter");
        return;
      }

      const rect = this.glass.getBoundingClientRect();
      if (rect.width && rect.height) {
        this.shader.setSize(rect.width, rect.height);
      }
      const filterValue = this.shader.filterValue();
      if (this.glass.style.getPropertyValue("--model-slider-liquid-filter") !== filterValue) {
        this.glass.style.setProperty("--model-slider-liquid-filter", filterValue);
      }
    }

    refreshSoon() {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => this.refresh());
        });
      }, 16);
    }

    requestUpdate() {
      if (this.raf) return;
      this.raf = window.requestAnimationFrame(() => {
        this.raf = 0;
        if (this.isLightTheme()) {
          this.shader.updateShader(this.mouse);
        }
        this.refresh();
      });
    }

    destroy() {
      if (this.raf) window.cancelAnimationFrame(this.raf);
      window.clearTimeout(this.refreshTimer);
      this.tabs?.removeEventListener("pointermove", this.onPointerMove);
      this.tabs?.removeEventListener("pointerleave", this.onPointerLeave);
      this.resizeObserver?.disconnect();
      this.glass?.style.removeProperty("--model-slider-liquid-filter");
      this.shader?.destroy();
      if (sliderBinding === this) sliderBinding = null;
    }
  }

  function cleanupButtonFilters(root = document) {
    root.querySelectorAll(BUTTON_SELECTOR).forEach((button) => {
      button.classList.remove("liquid-glass-source-bound", "liquid-glass-source-hover");
      button.style.removeProperty("--model-button-liquid-filter");
      button.style.removeProperty("filter");
      button.style.removeProperty("background");
      button.style.removeProperty("background-color");
      button.style.removeProperty("box-shadow");
    });
  }

  function resolveTabs(element) {
    if (element instanceof HTMLElement) {
      if (element.matches(TABS_SELECTOR)) return element;
      return element.closest(TABS_SELECTOR) || document.querySelector(TABS_SELECTOR);
    }
    return document.querySelector(TABS_SELECTOR);
  }

  function refreshElement(element) {
    const tabs = resolveTabs(element);
    if (!tabs) return;

    if (!sliderBinding || sliderBinding.tabs !== tabs || !sliderBinding.glass?.isConnected) {
      sliderBinding?.destroy();
      sliderBinding = new SliderLiquidGlass(tabs);
      return;
    }

    sliderBinding.refreshSoon();
  }

  function refresh() {
    refreshElement(document.querySelector(TABS_SELECTOR));
  }

  function debounce(fn, wait) {
    let timer = 0;
    return function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(fn, wait);
    };
  }

  function start() {
    window.ModelHubLiquidGlass = {
      refresh,
      refreshElement,
      SliderLiquidGlass,
      Shader: ShaderMap
    };

    refresh();
    const scheduleRefresh = debounce(refresh, 50);
    const bodyObserver = new MutationObserver(scheduleRefresh);
    bodyObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-model-id", "aria-pressed", "style"]
    });
    const themeObserver = new MutationObserver(scheduleRefresh);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    document.addEventListener("modelhub:refresh-liquid-glass", scheduleRefresh);
    window.addEventListener("resize", scheduleRefresh);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
