const CARD_MARGIN = 14;
const VIEWPORT_PADDING = 12;
const SPOTLIGHT_EDGE_PADDING = 0;
const HORIZONTAL_SPOTLIGHT_PADDING = 8;
const VERTICAL_SPOTLIGHT_PADDING = 6;
const SPOTLIGHT_RADIUS = 14;
const SPOTLIGHT_FEATHER = 10;

export function initOnboardingTour({
    storageKey,
    steps = [],
    startDelay = 350
} = {}) {
    if (!storageKey || !Array.isArray(steps) || !steps.length) {
        return;
    }

    try {
        if (window.localStorage.getItem(storageKey) === 'seen') {
            return;
        }
    } catch {
        return;
    }

    window.setTimeout(() => {
        const tour = createTour({ storageKey, steps });
        tour.start();
    }, startDelay);
}

function createTour({ storageKey, steps }) {
    let currentIndex = 0;
    let visibleSteps = [];
    let activeTarget = null;

    const root = document.createElement('div');
    root.className = 'onboarding-tour';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
        <div class="onboarding-tour__scrim"></div>
        <div class="onboarding-tour__spotlight" aria-hidden="true"></div>
        <section class="onboarding-tour__card" role="dialog" aria-modal="true" aria-live="polite" aria-labelledby="onboardingTourTitle">
            <div class="onboarding-tour__meta">
                <span class="onboarding-tour__label">Guide</span>
                <span class="onboarding-tour__count"></span>
            </div>
            <h2 id="onboardingTourTitle"></h2>
            <p></p>
            <div class="onboarding-tour__actions">
                <button class="onboarding-tour__ghost" type="button" data-tour-action="skip">Skip</button>
                <div>
                    <button class="onboarding-tour__ghost" type="button" data-tour-action="back">Back</button>
                    <button class="onboarding-tour__primary" type="button" data-tour-action="next">Next</button>
                </div>
            </div>
        </section>
    `;

    const scrim = root.querySelector('.onboarding-tour__scrim');
    const spotlight = root.querySelector('.onboarding-tour__spotlight');
    const card = root.querySelector('.onboarding-tour__card');
    const count = root.querySelector('.onboarding-tour__count');
    const title = root.querySelector('h2');
    const body = root.querySelector('p');
    const backButton = root.querySelector('[data-tour-action="back"]');
    const nextButton = root.querySelector('[data-tour-action="next"]');

    root.addEventListener('click', event => {
        const action = event.target?.closest('[data-tour-action]')?.dataset?.tourAction;

        if (action === 'skip') {
            finish();
        } else if (action === 'back') {
            showStep(currentIndex - 1);
        } else if (action === 'next') {
            if (currentIndex >= visibleSteps.length - 1) {
                finish();
            } else {
                showStep(currentIndex + 1);
            }
        }
    });

    window.addEventListener('keydown', event => {
        if (!root.classList.contains('show')) return;

        if (event.key === 'Escape') {
            finish();
        } else if (event.key === 'ArrowRight') {
            nextButton?.click();
        } else if (event.key === 'ArrowLeft' && currentIndex > 0) {
            backButton?.click();
        }
    });

    window.addEventListener('resize', () => {
        if (root.classList.contains('show')) {
            positionStep(visibleSteps[currentIndex]);
        }
    });

    function start() {
        visibleSteps = steps
            .map(step => ({ ...step, targetElement: findTarget(step) }))
            .filter(step => !step.target || step.targetElement);

        if (!visibleSteps.length) {
            markSeen(storageKey);
            return;
        }

        document.body.appendChild(root);
        root.classList.add('show');
        root.setAttribute('aria-hidden', 'false');
        showStep(0);
    }

    function showStep(index) {
        currentIndex = Math.max(0, Math.min(index, visibleSteps.length - 1));
        const step = visibleSteps[currentIndex];

        clearActiveTarget();

        activeTarget = step.targetElement || null;
        activeTarget?.classList.add('onboarding-tour-target');

        count.textContent = `${currentIndex + 1} / ${visibleSteps.length}`;
        title.textContent = step.title || '';
        body.textContent = step.body || '';
        backButton.disabled = currentIndex === 0;
        nextButton.textContent = currentIndex === visibleSteps.length - 1 ? 'Done' : 'Next';

        positionStep(step);
    }

    function positionStep(step) {
        const target = step?.targetElement;

        if (target && isScrollableTarget(target)) {
            target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        }

        window.requestAnimationFrame(() => {
            const rect = target ? getVisibleRect(target) : getFallbackRect();
            positionSpotlight(root, scrim, spotlight, rect);
            positionCard(card, rect, step?.placement);
        });
    }

    function finish() {
        markSeen(storageKey);
        clearActiveTarget();
        root.classList.remove('show');
        root.setAttribute('aria-hidden', 'true');
        root.remove();
    }

    function clearActiveTarget() {
        activeTarget?.classList.remove('onboarding-tour-target');
        activeTarget = null;
    }

    return { start };
}

function findTarget(step) {
    const selector = step.target || step.fallbackTarget;
    if (!selector) return null;

    const candidates = document.querySelectorAll(selector);
    return Array.from(candidates).find(isVisibleElement) || null;
}

function isVisibleElement(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return rect.width > 0
        && rect.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none';
}

function isScrollableTarget(target) {
    const style = window.getComputedStyle(target);
    return style.position !== 'fixed' && style.position !== 'sticky';
}

function getVisibleRect(element) {
    const rect = element.getBoundingClientRect();
    const clippedRect = getClippingAncestors(element).reduce((currentRect, ancestor) => {
        const ancestorRect = ancestor.getBoundingClientRect();
        return intersectRects(currentRect, ancestorRect);
    }, rect);

    return intersectRects(clippedRect, {
        top: 0,
        left: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        width: window.innerWidth,
        height: window.innerHeight
    });
}

function getClippingAncestors(element) {
    const ancestors = [];
    let parent = element.parentElement;

    while (parent && parent !== document.body) {
        const style = window.getComputedStyle(parent);
        const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;

        if (/(auto|scroll|hidden|clip)/.test(overflow)) {
            ancestors.push(parent);
        }

        parent = parent.parentElement;
    }

    return ancestors;
}

function intersectRects(a, b) {
    const top = Math.max(a.top, b.top);
    const left = Math.max(a.left, b.left);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    if (!width || !height) {
        return getFallbackRect();
    }

    return { top, left, right, bottom, width, height };
}

function positionSpotlight(root, scrim, spotlight, rect) {
    const spotlightRect = getCenteredSpotlightRect(rect);
    const { top, left, right, bottom, width, height } = spotlightRect;

    root.style.setProperty('--tour-hole-top', `${top}px`);
    root.style.setProperty('--tour-hole-right', `${Math.max(0, window.innerWidth - right)}px`);
    root.style.setProperty('--tour-hole-bottom', `${Math.max(0, window.innerHeight - bottom)}px`);
    root.style.setProperty('--tour-hole-left', `${left}px`);

    spotlight.style.transform = `translate(${left}px, ${top}px)`;
    spotlight.style.width = `${width}px`;
    spotlight.style.height = `${height}px`;

    updateScrimMask(scrim, spotlightRect);
}

function getCenteredSpotlightRect(rect) {
    const maxLeft = Math.max(SPOTLIGHT_EDGE_PADDING, rect.left);
    const maxRight = Math.max(SPOTLIGHT_EDGE_PADDING, window.innerWidth - rect.right);
    const maxTop = Math.max(SPOTLIGHT_EDGE_PADDING, rect.top);
    const maxBottom = Math.max(SPOTLIGHT_EDGE_PADDING, window.innerHeight - rect.bottom);
    const horizontalPadding = Math.min(HORIZONTAL_SPOTLIGHT_PADDING, maxLeft - SPOTLIGHT_EDGE_PADDING, maxRight - SPOTLIGHT_EDGE_PADDING);
    const verticalPadding = Math.min(VERTICAL_SPOTLIGHT_PADDING, maxTop - SPOTLIGHT_EDGE_PADDING, maxBottom - SPOTLIGHT_EDGE_PADDING);
    const left = rect.left - horizontalPadding;
    const right = rect.right + horizontalPadding;
    const top = rect.top - verticalPadding;
    const bottom = rect.bottom + verticalPadding;

    return {
        top,
        left,
        right,
        bottom,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top)
    };
}

function updateScrimMask(scrim, rect) {
    if (!scrim) return;

    const radius = Math.min(SPOTLIGHT_RADIUS, rect.width / 2, rect.height / 2);
    const x = round(rect.left);
    const y = round(rect.top);
    const width = round(rect.width);
    const height = round(rect.height);
    const right = round(x + width);
    const bottom = round(y + height);
    const r = round(radius);
    const viewportWidth = round(window.innerWidth);
    const viewportHeight = round(window.innerHeight);
    const filterInset = SPOTLIGHT_FEATHER * 4;
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${viewportWidth}" height="${viewportHeight}" viewBox="0 0 ${viewportWidth} ${viewportHeight}">
            <defs>
                <filter id="tour-feather" x="${x - filterInset}" y="${y - filterInset}" width="${width + filterInset * 2}" height="${height + filterInset * 2}" filterUnits="userSpaceOnUse">
                    <feGaussianBlur stdDeviation="${SPOTLIGHT_FEATHER}" />
                </filter>
                <mask id="tour-mask" maskUnits="userSpaceOnUse">
                    <rect width="${viewportWidth}" height="${viewportHeight}" fill="white" />
                    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${r}" ry="${r}" fill="black" filter="url(#tour-feather)" />
                </mask>
            </defs>
            <rect width="${viewportWidth}" height="${viewportHeight}" fill="white" mask="url(#tour-mask)" />
        </svg>
    `.trim();
    const maskImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

    scrim.style.maskImage = maskImage;
    scrim.style.webkitMaskImage = maskImage;
    scrim.style.maskSize = '100% 100%';
    scrim.style.webkitMaskSize = '100% 100%';
    scrim.style.maskRepeat = 'no-repeat';
    scrim.style.webkitMaskRepeat = 'no-repeat';
}

function round(value) {
    return Math.round(value * 100) / 100;
}

function positionCard(card, rect, preferredPlacement) {
    const cardRect = card.getBoundingClientRect();
    const cardWidth = cardRect.width;
    const cardHeight = cardRect.height;
    const placement = preferredPlacement || getBestPlacement(rect, cardWidth, cardHeight);

    let left = rect.right + CARD_MARGIN;
    let top = rect.top + (rect.height - cardHeight) / 2;

    if (placement === 'left') {
        left = rect.left - cardWidth - CARD_MARGIN;
    } else if (placement === 'top') {
        left = rect.left + (rect.width - cardWidth) / 2;
        top = rect.top - cardHeight - CARD_MARGIN;
    } else if (placement === 'bottom') {
        left = rect.left + (rect.width - cardWidth) / 2;
        top = rect.bottom + CARD_MARGIN;
    } else if (placement === 'center') {
        left = (window.innerWidth - cardWidth) / 2;
        top = (window.innerHeight - cardHeight) / 2;
    }

    card.style.transform = `translate(${clamp(left, VIEWPORT_PADDING, window.innerWidth - cardWidth - VIEWPORT_PADDING)}px, ${clamp(top, VIEWPORT_PADDING, window.innerHeight - cardHeight - VIEWPORT_PADDING)}px)`;
}

function getBestPlacement(rect, cardWidth, cardHeight) {
    const rightSpace = window.innerWidth - rect.right;
    const leftSpace = rect.left;
    const bottomSpace = window.innerHeight - rect.bottom;
    const topSpace = rect.top;

    if (rightSpace >= cardWidth + CARD_MARGIN + VIEWPORT_PADDING) return 'right';
    if (leftSpace >= cardWidth + CARD_MARGIN + VIEWPORT_PADDING) return 'left';
    if (bottomSpace >= cardHeight + CARD_MARGIN + VIEWPORT_PADDING) return 'bottom';
    if (topSpace >= cardHeight + CARD_MARGIN + VIEWPORT_PADDING) return 'top';
    return 'center';
}

function getFallbackRect() {
    return {
        top: window.innerHeight / 2 - 1,
        left: window.innerWidth / 2 - 1,
        right: window.innerWidth / 2 + 1,
        bottom: window.innerHeight / 2 + 1,
        width: 2,
        height: 2
    };
}

function markSeen(storageKey) {
    try {
        window.localStorage.setItem(storageKey, 'seen');
    } catch {
        // Private browsing or blocked storage should not break the page.
    }
}

function clamp(value, min, max) {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
}
