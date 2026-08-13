import {
  Client,
  GatewayIntentBits,
  TextChannel,
} from "discord.js";

import dotenv from "dotenv";

import {
  createDealMatcher,
  parseDrmNamesFromEnv,
} from "./services/dealFilters";

import { ITADApi } from "./services/ITADApi";

import { DeduplicationService } from "./services/deduplication";

import {
  ITADConfig,
  ITADDeal,
  ITADGameInfo,
  ITADReview,
} from "./types";

dotenv.config();

if (
  !process.env.DISCORD_TOKEN ||
  !process.env.DISCORD_CHANNEL_ID ||
  !process.env.ITAD_API_KEY
) {
  console.error(
    "Missing required environment variables: DISCORD_TOKEN, DISCORD_CHANNEL_ID, or ITAD_API_KEY",
  );

  process.exit(1);
}

const DISCORD_TOKEN =
  process.env.DISCORD_TOKEN;

const CHANNEL_ID =
  process.env.DISCORD_CHANNEL_ID;

const ITAD_API_KEY =
  process.env.ITAD_API_KEY;

/**
 * Number of deals eventually posted.
 */
const DEAL_LIMIT =
  parseInt(
    process.env.DEAL_LIMIT ||
      "10",
    10,
  );

/**
 * Discount is intentionally less strict now.
 *
 * Quality and popularity have much more weight.
 */
const MIN_SAVINGS =
  parseInt(
    process.env.MIN_SAVINGS ||
      "50",
    10,
  );

const MAX_SAVINGS =
  parseInt(
    process.env.MAX_SAVINGS ||
      "100",
    10,
  );

/**
 * Actual Steam quality filters.
 *
 * These are checked using /games/info/v2,
 * NOT /deals/v2.
 */
const MIN_REVIEW_COUNT =
  parseInt(
    process.env
      .MIN_REVIEW_COUNT ||
      "5000",
    10,
  );

const MIN_RATING =
  parseInt(
    process.env.MIN_RATING ||
      "75",
    10,
  );

const MIN_HOURS_UNTIL_EXPIRY =
  parseInt(
    process.env
      .MIN_HOURS_UNTIL_EXPIRY ||
      "0",
    10,
  );

/**
 * Search within the N most popular ITAD games.
 *
 * Higher number = more inclusive.
 */
const POPULARITY_POOL =
  parseInt(
    process.env
      .POPULARITY_POOL ||
      "2000",
    10,
  );

/**
 * After intersecting sales with popularity,
 * only load expensive Game Info data for
 * the most promising candidates.
 */
const QUALITY_CANDIDATES =
  parseInt(
    process.env
      .QUALITY_CANDIDATES ||
      "80",
    10,
  );

/**
 * Maximum number of /deals pages to scan.
 *
 * Each page contains 200 offers.
 */
const MAX_DEAL_PAGES =
  parseInt(
    process.env
      .MAX_DEAL_PAGES ||
      "50",
    10,
  );

const COUNTRY =
  process.env.COUNTRY ||
  "BR";

const DEDUPLICATION_DAYS =
  parseInt(
    process.env
      .DEDUPLICATION_DAYS ||
      "3",
    10,
  );

const TEST_MODE =
  process.env.TEST_MODE ===
  "true";

/**
 * Steam = 61
 */
const SHOP_IDS =
  process.env.SHOP_IDS
    ? process.env.SHOP_IDS
        .split(",")
        .map((id) =>
          parseInt(
            id.trim(),
            10,
          ),
        )
        .filter(
          (id) =>
            !Number.isNaN(
              id,
            ),
        )
    : [61];

const REQUIRED_DRM_NAMES =
  parseDrmNamesFromEnv(
    process.env
      .REQUIRED_DRM_NAMES,
  );

const client =
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ],
  });

const deduplicationService =
  new DeduplicationService(
    "./deal-history.json",
    DEDUPLICATION_DAYS,
  );

interface RankedCandidate {
  deal: ITADDeal;
  info: ITADGameInfo;
  steamReview: ITADReview;
  popularityPosition: number;
  qualityScore: number;
}

/**
 * Find Steam review object.
 */
function getSteamReview(
  info: ITADGameInfo,
): ITADReview | undefined {
  return info.reviews?.find(
    (review) =>
      review.source.toLowerCase() ===
      "steam",
  );
}

/**
 * QUALITY SCORE — 100 possible points.
 *
 * 50% = Steam rating
 * 25% = ITAD popularity
 * 20% = review count
 *  5% = discount
 *
 * Discount deliberately has very little weight.
 */
function calculateQualityScore(
  deal: ITADDeal,
  steamReview: ITADReview,
  popularityPosition: number,
): number {
  /**
   * 0-50 points
   */
  const ratingScore =
    Math.min(
      steamReview.score,
      100,
    ) /
    100 *
    50;

  /**
   * 0-20 points
   *
   * Logarithmic because the difference between
   * 1,000 and 10,000 reviews matters much more
   * than the difference between 900,000 and
   * 910,000.
   *
   * 1,000,000 reviews ~= maximum.
   */
  const reviewScore =
    Math.min(
      Math.log10(
        steamReview.count + 1,
      ) / 6,
      1,
    ) * 20;

  /**
   * 0-25 points
   *
   * #1 ITAD gets nearly 25 points.
   * Last game in pool approaches 0.
   */
  const popularityRatio =
    POPULARITY_POOL <= 1
      ? 1
      : Math.max(
          0,
          1 -
            (popularityPosition -
              1) /
              (POPULARITY_POOL -
                1),
        );

  const popularityScore =
    popularityRatio * 25;

  /**
   * Only 5 points depend on discount.
   *
   * This prevents 95%-off shovelware
   * beating a great 60%-off game.
   */
  const discountScore =
    Math.min(
      deal.deal.cut,
      100,
    ) /
    100 *
    5;

  return (
    ratingScore +
    reviewScore +
    popularityScore +
    discountScore
  );
}

async function postDeals() {
  try {
    console.log(
      "=".repeat(60),
    );

    console.log(
      "ITAD Quality Game Deals Bot - Starting...",
    );

    console.log(
      "=".repeat(60),
    );

    console.log(
      `Mode: ${
        TEST_MODE
          ? "TEST"
          : "LIVE"
      }`,
    );

    console.log(
      "\n🔧 Configuration:",
    );

    console.log(
      `   Country: ${COUNTRY}`,
    );

    console.log(
      `   Shop IDs: ${SHOP_IDS.join(", ")}`,
    );

    console.log(
      `   Min savings: ${MIN_SAVINGS}%`,
    );

    console.log(
      `   Max savings: ${MAX_SAVINGS}%`,
    );

    console.log(
      `   Min Steam reviews: ${MIN_REVIEW_COUNT.toLocaleString()}`,
    );

    console.log(
      `   Min Steam rating: ${MIN_RATING}%`,
    );

    console.log(
      `   Popularity pool: top ${POPULARITY_POOL}`,
    );

    console.log(
      `   Quality candidates: ${QUALITY_CANDIDATES}`,
    );

    console.log(
      `   Max deal pages: ${MAX_DEAL_PAGES}`,
    );

    console.log(
      `   Final deals: ${DEAL_LIMIT}`,
    );

    console.log(
      `   Deduplication: ${DEDUPLICATION_DAYS} days`,
    );

    console.log(
      `   Required DRM: ${
        REQUIRED_DRM_NAMES.length >
        0
          ? REQUIRED_DRM_NAMES.join(
              ", ",
            )
          : "any"
      }`,
    );

    const api =
      new ITADApi(
        ITAD_API_KEY,
      );

    /**
     * Step 1:
     * load ITAD popularity ranking.
     */
    const popularGames =
      await api.getMostPopular(
        POPULARITY_POOL,
      );

    const popularityMap =
      new Map<
        string,
        number
      >();

    for (
      const game of popularGames
    ) {
      popularityMap.set(
        game.id,
        game.position,
      );
    }

    /**
     * Step 2:
     * configure deal search.
     *
     * IMPORTANT:
     * reviews are NOT sent to /deals/v2.
     */
    const pageSize = 200;

    const baseConfig:
      ITADConfig = {
      country: COUNTRY,
      shops: SHOP_IDS,

      /**
       * We can leave discount sorting here
       * because we scan many pages before
       * ranking candidates ourselves.
       */
      sort: "-cut",

      minSavings:
        MIN_SAVINGS,

      maxSavings:
        MAX_SAVINGS,

      limit: pageSize,
    };

    const dealMatcher =
      createDealMatcher({
        minSavings:
          MIN_SAVINGS,

        maxSavings:
          MAX_SAVINGS,

        requiredDrmNames:
          REQUIRED_DRM_NAMES,

        minHoursUntilExpiry:
          MIN_HOURS_UNTIL_EXPIRY,
      });

    const postedIds =
      deduplicationService
        .getPostedDealIds();

    /**
     * All popular discounted candidates.
     */
    const candidateMap =
      new Map<
        string,
        ITADDeal
      >();

    let offset = 0;
    let pageNumber = 0;
    let totalScanned = 0;

    let skippedBasicFilter =
      0;

    let skippedPosted =
      0;

    let skippedNotPopular =
      0;

    let skippedDuplicate =
      0;

    console.log(
      "\n📡 Scanning Steam deals...",
    );

    /**
     * IMPORTANT:
     *
     * We DON'T stop after finding 10 or 80 deals.
     *
     * This gives games with lower discounts a chance
     * to appear later in the ITAD result set.
     */
    while (
      pageNumber <
      MAX_DEAL_PAGES
    ) {
      if (
        pageNumber > 0
      ) {
        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              200,
            ),
        );
      }

      let page;

try {
  page = await api.fetchDealsPage({
    ...baseConfig,
    offset,
  });
} catch (error) {
  console.warn(
    `⚠️ Failed to fetch deal page ${pageNumber + 1}:`,
    error,
  );

  /**
   * If we already collected enough candidates,
   * continue with what we have instead of killing the job.
   */
  if (candidateMap.size >= QUALITY_CANDIDATES) {
    console.warn(
      `⚠️ ITAD became unavailable, but we already have ${candidateMap.size} candidates. Continuing with quality ranking.`,
    );

    break;
  }

  /**
   * If we don't even have enough candidates yet,
   * propagate the error.
   */
  throw error;
}

      pageNumber++;

      if (
        page.list.length ===
        0
      ) {
        console.log(
          `Page ${pageNumber}: no more deals`,
        );

        break;
      }

      totalScanned +=
        page.list.length;

      for (
        const deal of page.list
      ) {
        if (
          !dealMatcher(deal)
        ) {
          skippedBasicFilter++;

          continue;
        }

        if (
          postedIds.has(
            deal.id,
          )
        ) {
          skippedPosted++;

          continue;
        }

        if (
          !popularityMap.has(
            deal.id,
          )
        ) {
          skippedNotPopular++;

          continue;
        }

        if (
          candidateMap.has(
            deal.id,
          )
        ) {
          skippedDuplicate++;

          continue;
        }

        candidateMap.set(
          deal.id,
          deal,
        );
      }

      console.log(
        `Page ${pageNumber}: ` +
          `${page.list.length} scanned | ` +
          `${candidateMap.size} popular candidates`,
      );
/**
 * We only inspect QUALITY_CANDIDATES games later.
 *
 * Keep a small reserve of 20 candidates, then stop
 * hammering the deals endpoint unnecessarily.
 */
const candidateTarget =
  QUALITY_CANDIDATES + 20;

if (
  candidateMap.size >= candidateTarget
) {
  console.log(
    `🎯 Candidate target reached: ${candidateMap.size}/${candidateTarget}. Stopping deal scan.`,
  );

  break;
}
      if (
        page.nextOffset ===
        offset
      ) {
        console.warn(
          "ITAD returned identical offset. Stopping.",
        );

        break;
      }

      offset =
        page.nextOffset;
    }

    console.log(
      "\n✓ Deal scan complete",
    );

    console.log(
      `   Scanned: ${totalScanned}`,
    );

    console.log(
      `   Popular candidates: ${candidateMap.size}`,
    );

    console.log(
      `   Basic filter rejected: ${skippedBasicFilter}`,
    );

    console.log(
      `   Already posted: ${skippedPosted}`,
    );

    console.log(
      `   Outside popularity pool: ${skippedNotPopular}`,
    );

    console.log(
      `   Duplicates: ${skippedDuplicate}`,
    );

    if (
      candidateMap.size ===
      0
    ) {
      console.log(
        "\nNo popular discounted candidates found.",
      );

      deduplicationService
        .markDealsAsPosted(
          [],
        );

      return;
    }

    /**
     * Step 3:
     *
     * Sort candidates by popularity BEFORE
     * calling Game Info.
     *
     * This prevents making hundreds/thousands
     * of API requests.
     */
    const candidates =
      Array.from(
        candidateMap.values(),
      )
        .sort(
          (a, b) =>
            (popularityMap.get(
              a.id,
            ) ?? Infinity) -
            (popularityMap.get(
              b.id,
            ) ?? Infinity),
        )
        .slice(
          0,
          QUALITY_CANDIDATES,
        );

    console.log(
      `\n🎯 Inspecting the ${candidates.length} most popular sale candidates...`,
    );

    /**
     * Step 4:
     * retrieve full review/stat data.
     */
    const infoMap =
      await api.getGameInfo(
        candidates.map(
          (deal) =>
            deal.id,
        ),
      );

    /**
     * Step 5:
     * Steam quality filtering + score.
     */
    const ranked:
      RankedCandidate[] =
      [];

    let missingInfo = 0;
    let missingReviews = 0;
    let lowReviewCount = 0;
    let lowRating = 0;

    for (
      const deal of candidates
    ) {
      const info =
        infoMap.get(
          deal.id,
        );

      if (!info) {
        missingInfo++;

        continue;
      }

      const steamReview =
        getSteamReview(
          info,
        );

      if (
        !steamReview
      ) {
        missingReviews++;

        continue;
      }

      if (
        steamReview.count <
        MIN_REVIEW_COUNT
      ) {
        lowReviewCount++;

        continue;
      }

      if (
        steamReview.score <
        MIN_RATING
      ) {
        lowRating++;

        continue;
      }

      const popularityPosition =
        popularityMap.get(
          deal.id,
        );

      if (
        popularityPosition ===
        undefined
      ) {
        continue;
      }

      const qualityScore =
        calculateQualityScore(
          deal,
          steamReview,
          popularityPosition,
        );

      ranked.push({
        deal,
        info,
        steamReview,
        popularityPosition,
        qualityScore,
      });
    }

    /**
     * Best games first.
     *
     * Discount is only a tie breaker after quality score.
     */
    ranked.sort(
      (a, b) => {
        const scoreDifference =
          b.qualityScore -
          a.qualityScore;

        if (
          Math.abs(
            scoreDifference,
          ) > 0.001
        ) {
          return scoreDifference;
        }

        return (
          b.deal.deal.cut -
          a.deal.deal.cut
        );
      },
    );

    console.log(
      "\n🧠 Quality filtering:",
    );

    console.log(
      `   Detailed info missing: ${missingInfo}`,
    );

    console.log(
      `   No Steam reviews: ${missingReviews}`,
    );

    console.log(
      `   Fewer than ${MIN_REVIEW_COUNT.toLocaleString()} reviews: ${lowReviewCount}`,
    );

    console.log(
      `   Rating below ${MIN_RATING}%: ${lowRating}`,
    );

    console.log(
      `   Passed quality filters: ${ranked.length}`,
    );

    /**
     * Show ranking in GitHub log.
     */
    console.log(
      "\n🏆 Best candidates:",
    );

    ranked
      .slice(0, 15)
      .forEach(
        (
          candidate,
          index,
        ) => {
          console.log(
            `   ${index + 1}. ` +
              `${candidate.deal.title} | ` +
              `Score ${candidate.qualityScore.toFixed(1)} | ` +
              `${candidate.steamReview.score}% | ` +
              `${candidate.steamReview.count.toLocaleString()} reviews | ` +
              `Popular #${candidate.popularityPosition} | ` +
              `${candidate.deal.deal.cut}% OFF`,
          );
        },
      );

    const selected =
      ranked.slice(
        0,
        DEAL_LIMIT,
      );

    if (
      selected.length ===
      0
    ) {
      console.log(
        "\nNo new quality deals found.",
      );

      deduplicationService
        .markDealsAsPosted(
          [],
        );

      return;
    }

    console.log(
      `\n✅ Selected ${selected.length} quality deals`,
    );

    /**
     * Test mode
     */
    if (TEST_MODE) {
      console.log(
        "\n" +
          "=".repeat(60),
      );

      console.log(
        "TEST MODE - Selected deals:",
      );

      console.log(
        "=".repeat(60),
      );

      for (
        let i = 0;
        i <
        selected.length;
        i++
      ) {
        const candidate =
          selected[i];

        console.log(
          `\n${i + 1}. ` +
            api.formatDealMessage(
              candidate.deal,
              candidate.info,
              candidate.popularityPosition,
            ),
        );

        console.log(
          `Quality score: ${candidate.qualityScore.toFixed(1)}`,
        );
      }

      deduplicationService
        .markDealsAsPosted(
          [],
        );

      return;
    }

    /**
     * Discord
     */
    console.log(
      "\n📨 Posting to Discord...",
    );

    const fetchedChannel =
      await client.channels.fetch(
        CHANNEL_ID,
      );

    if (
      !fetchedChannel
    ) {
      throw new Error(
        `Discord channel ${CHANNEL_ID} not found`,
      );
    }

    if (
      !fetchedChannel.isTextBased()
    ) {
      throw new Error(
        `Discord channel ${CHANNEL_ID} is not text based`,
      );
    }

    const channel =
      fetchedChannel as
        TextChannel;

    const embeds =
      selected.map(
        (candidate) =>
          api.formatDealEmbed(
            candidate.deal,
            candidate.info,
            candidate.popularityPosition,
          ),
      );

    const BATCH_SIZE = 10;

    for (
      let i = 0;
      i < embeds.length;
      i += BATCH_SIZE
    ) {
      const batch =
        embeds.slice(
          i,
          i + BATCH_SIZE,
        );

      await channel.send({
        embeds:
          batch as any,
      });

      console.log(
        `Posted embeds ` +
          `${i + 1}-` +
          `${Math.min(
            i +
              BATCH_SIZE,
            embeds.length,
          )}`,
      );

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            500,
          ),
      );
    }

    /**
     * Only selected games become "posted".
     */
    deduplicationService
      .markDealsAsPosted(
        selected.map(
          (candidate) =>
            candidate.deal,
        ),
      );

    console.log(
      "\n" +
        "=".repeat(60),
    );

    console.log(
      "✅ Quality deals posted successfully",
    );

    console.log(
      "=".repeat(60),
    );
  } catch (error) {
    console.error(
      "\n❌ Error posting deals:",
      error,
    );

    throw error;
  }
}

client.once(
  "clientReady",
  async () => {
    if (!TEST_MODE) {
      console.log(
        `✅ Logged in as ${client.user?.tag}`,
      );

      console.log(
        `📺 Channel ID: ${CHANNEL_ID}`,
      );
    }

    try {
      await postDeals();
    } catch (error) {
      console.error(
        "\n❌ Fatal error:",
        error,
      );

      process.exit(1);
    }

    console.log(
      "\n✅ Job completed, exiting...",
    );

    process.exit(0);
  },
);

if (TEST_MODE) {
  console.log(
    "🧪 TEST_MODE enabled\n",
  );

  postDeals()
    .then(() => {
      process.exit(0);
    })
    .catch(
      (error) => {
        console.error(
          error,
        );

        process.exit(1);
      },
    );
} else {
  client.login(
    DISCORD_TOKEN,
  );
}
