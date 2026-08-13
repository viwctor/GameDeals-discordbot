import { ITADDeal, ITADReview } from "../types";

export interface DealFilterCriteria {
  minSavings: number;
  maxSavings: number;
  minReviewCount?: number;
  minRating?: number;
  allowedTypes?: ReadonlySet<string | null>;
  requiredDrmNames?: readonly string[];
  minHoursUntilExpiry?: number;
}

export type DealPredicate = (deal: ITADDeal) => boolean;

/**
 * By default, only actual games are accepted.
 * This helps exclude DLCs, bundles, soundtracks, etc.
 */
const DEFAULT_ALLOWED_TYPES: ReadonlySet<string | null> = new Set([
  "game",
]);

/**
 * Do not reject deals based on expiry by default.
 */
const DEFAULT_MIN_HOURS_UNTIL_EXPIRY = 0;

/**
 * Check whether the ITAD item actually contains deal information.
 */
export function hasDealInfo(deal: ITADDeal): boolean {
  return Boolean(deal.deal);
}

/**
 * Accept only allowed item types.
 */
export function isAllowedType(
  deal: ITADDeal,
  allowedTypes: ReadonlySet<string | null>,
): boolean {
  return allowedTypes.has(deal.type);
}

/**
 * Check whether the discount percentage is inside the desired range.
 */
export function savingsInRange(
  deal: ITADDeal,
  minSavings: number,
  maxSavings: number,
): boolean {
  const cut = deal.deal?.cut ?? 0;

  return cut >= minSavings && cut <= maxSavings;
}

/**
 * Optional DRM filter.
 *
 * An empty array means "accept any DRM".
 *
 * Since SHOP_IDS=61 already restricts results to Steam,
 * we intentionally leave this filter disabled in our setup.
 */
export function hasAnyDrmName(
  deal: ITADDeal,
  drmNames: readonly string[],
): boolean {
  if (drmNames.length === 0) {
    return true;
  }

  return (
    deal.deal?.drm?.some((drmInfo) =>
      drmNames.some(
        (name) =>
          name.toLowerCase() === drmInfo.name.toLowerCase(),
      ),
    ) ?? false
  );
}

/**
 * Reject deals that expire too soon.
 *
 * With minHoursUntilExpiry = 0, every currently-valid deal
 * is accepted regardless of how soon it expires.
 */
export function expiresAfterWindow(
  deal: ITADDeal,
  minHoursUntilExpiry: number,
): boolean {
  const expiry = deal.deal?.expiry;

  if (!expiry) {
    return true;
  }

  const expiryTime = Date.parse(expiry);

  if (Number.isNaN(expiryTime)) {
    return true;
  }

  const minExpiryMs =
    minHoursUntilExpiry * 60 * 60 * 1000;

  return expiryTime - Date.now() > minExpiryMs;
}

/**
 * Locate the Steam review information inside the ITAD response.
 */
export function getSteamReview(
  deal: ITADDeal,
): ITADReview | undefined {
  return deal.reviews?.find(
    (review) =>
      review.source.toLowerCase() === "steam",
  );
}

/**
 * Filter deals based on Steam review count and rating.
 *
 * Example:
 *   minReviewCount = 5000
 *   minRating = 75
 *
 * means:
 *   at least 5,000 Steam reviews
 *   and at least 75% positive rating.
 */
export function meetsReviewRequirements(
  deal: ITADDeal,
  minReviewCount: number,
  minRating: number,
): boolean {
  /**
   * If both filters are disabled,
   * review information is not required.
   */
  if (minReviewCount <= 0 && minRating <= 0) {
    return true;
  }

  const steamReview = getSteamReview(deal);

  /**
   * If review filters are enabled but ITAD does not provide
   * Steam review information, reject the deal.
   */
  if (!steamReview) {
    return false;
  }

  if (steamReview.count < minReviewCount) {
    return false;
  }

  if (steamReview.score < minRating) {
    return false;
  }

  return true;
}

/**
 * Creates the predicate used by DealCollector.
 *
 * Filter order:
 * 1. Deal information exists
 * 2. Item is an allowed type
 * 3. Discount is inside the configured range
 * 4. Steam reviews satisfy popularity/quality requirements
 * 5. DRM requirement (normally disabled for our setup)
 * 6. Expiration requirement
 */
export function createDealMatcher(
  criteria: DealFilterCriteria,
): DealPredicate {
  const allowedTypes =
    criteria.allowedTypes ?? DEFAULT_ALLOWED_TYPES;

  const requiredDrmNames =
    criteria.requiredDrmNames ?? [];

  const minHoursUntilExpiry =
    criteria.minHoursUntilExpiry ??
    DEFAULT_MIN_HOURS_UNTIL_EXPIRY;

  const minReviewCount =
    criteria.minReviewCount ?? 0;

  const minRating =
    criteria.minRating ?? 0;

  return (deal: ITADDeal): boolean => {
    if (!hasDealInfo(deal)) {
      return false;
    }

    if (!isAllowedType(deal, allowedTypes)) {
      return false;
    }

    if (
      !savingsInRange(
        deal,
        criteria.minSavings,
        criteria.maxSavings,
      )
    ) {
      return false;
    }

    if (
      !meetsReviewRequirements(
        deal,
        minReviewCount,
        minRating,
      )
    ) {
      return false;
    }

    if (
      !hasAnyDrmName(
        deal,
        requiredDrmNames,
      )
    ) {
      return false;
    }

    if (
      !expiresAfterWindow(
        deal,
        minHoursUntilExpiry,
      )
    ) {
      return false;
    }

    return true;
  };
}

/**
 * Parse comma-separated DRM names from an environment variable.
 *
 * Examples:
 *   "Steam"
 *   "Steam,GOG"
 *
 * Empty / undefined = no DRM restriction.
 */
export function parseDrmNamesFromEnv(
  rawValue: string | undefined,
): string[] {
  if (
    !rawValue ||
    rawValue.trim().length === 0
  ) {
    return [];
  }

  return rawValue
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
