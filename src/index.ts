import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import dotenv from "dotenv";
import { DealCollector } from "./services/dealCollector";
import {
  createDealMatcher,
  parseDrmNamesFromEnv,
} from "./services/dealFilters";
import { ITADApi } from "./services/ITADApi";
import { DeduplicationService } from "./services/deduplication";
import { ITADConfig } from "./types";

dotenv.config();

/**
 * Required environment variables
 */
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

const DISCORD_TOKEN: string = process.env.DISCORD_TOKEN;
const CHANNEL_ID: string = process.env.DISCORD_CHANNEL_ID;
const ITAD_API_KEY: string = process.env.ITAD_API_KEY;

/**
 * Deal configuration
 */
const DEAL_LIMIT = parseInt(process.env.DEAL_LIMIT || "10", 10);

const MIN_SAVINGS = parseInt(
  process.env.MIN_SAVINGS || "80",
  10,
);

const MAX_SAVINGS = parseInt(
  process.env.MAX_SAVINGS || "100",
  10,
);

const MIN_REVIEW_COUNT = parseInt(
  process.env.MIN_REVIEW_COUNT || "5000",
  10,
);

const MIN_RATING = parseInt(
  process.env.MIN_RATING || "75",
  10,
);

const MIN_HOURS_UNTIL_EXPIRY = parseInt(
  process.env.MIN_HOURS_UNTIL_EXPIRY || "0",
  10,
);

const COUNTRY = process.env.COUNTRY || "BR";

const DEDUPLICATION_DAYS = parseInt(
  process.env.DEDUPLICATION_DAYS || "3",
  10,
);

const TEST_MODE = process.env.TEST_MODE === "true";

/**
 * Shop IDs
 *
 * Steam = 61
 */
const SHOP_IDS = process.env.SHOP_IDS
  ? process.env.SHOP_IDS
      .split(",")
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !Number.isNaN(id))
  : [61];

/**
 * DRM filtering
 *
 * Leaving REQUIRED_DRM_NAMES undefined means no DRM filtering.
 * This is intentional because SHOP_IDS=61 already limits results
 * to the Steam store.
 */
const REQUIRED_DRM_NAMES = parseDrmNamesFromEnv(
  process.env.REQUIRED_DRM_NAMES,
);

/**
 * Discord client
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

/**
 * Deal deduplication
 */
const deduplicationService = new DeduplicationService(
  "./deal-history.json",
  DEDUPLICATION_DAYS,
);

/**
 * Main deal collection/posting function
 */
async function postDeals() {
  try {
    console.log("=".repeat(60));
    console.log("ITAD Game Deals Bot - Starting...");
    console.log("=".repeat(60));

    console.log(
      `Mode: ${TEST_MODE ? "TEST (Console Only)" : "LIVE (Discord)"}`,
    );

    console.log(`Deal limit: ${DEAL_LIMIT}`);
    console.log(`Min savings: ${MIN_SAVINGS}%`);
    console.log(`Country: ${COUNTRY}`);
    console.log(`Shops: ${SHOP_IDS.join(", ")}`);

    console.log("=".repeat(60));

    /**
     * ITAD API
     */
    const api = new ITADApi(ITAD_API_KEY);

    /**
     * ITAD query configuration
     */
    const pageSize = 200;

    const baseConfig: ITADConfig = {
  country: COUNTRY,

  // Highest discounts first
  sort: "-cut",

  shops: SHOP_IDS,

  minSavings: MIN_SAVINGS,
  maxSavings: MAX_SAVINGS,

  minReviewCount: MIN_REVIEW_COUNT,
  minRating: MIN_RATING,

  limit: pageSize,
};

    /**
     * Print effective configuration
     */
    console.log("\n🔧 Configuration:");
    console.log(`   Country: ${COUNTRY}`);
    console.log(`   Shop IDs: ${SHOP_IDS.join(", ")}`);
    console.log(`   Min Savings: ${MIN_SAVINGS}%`);
    console.log(`   Max Savings: ${MAX_SAVINGS}%`);
    console.log(`   Min reviews: ${MIN_REVIEW_COUNT}`);
    console.log(`   Min rating: ${MIN_RATING}%`);
    console.log(
      `   Min hours until expiry: ${MIN_HOURS_UNTIL_EXPIRY}`,
    );
    console.log(`   Target deals: ${DEAL_LIMIT}`);
    console.log(
      `   Required DRM: ${
        REQUIRED_DRM_NAMES.length > 0
          ? REQUIRED_DRM_NAMES.join(", ")
          : "any"
      }`,
    );

    /**
     * Local filtering
     */
    const dealMatcher = createDealMatcher({
      minSavings: MIN_SAVINGS,
      maxSavings: MAX_SAVINGS,

      minReviewCount: MIN_REVIEW_COUNT,
      minRating: MIN_RATING,

      requiredDrmNames: REQUIRED_DRM_NAMES,

      minHoursUntilExpiry: MIN_HOURS_UNTIL_EXPIRY,
    });

    console.log(
      "\n📡 Scanning ITAD pages for matching deals...",
    );

    /**
     * Already-posted deals
     */
    const postedIds =
      deduplicationService.getPostedDealIds();

    const collector = new DealCollector(
      DEAL_LIMIT,
      postedIds,
      dealMatcher,
    );

    let offset = 0;
    let pageNumber = 0;
    let totalScanned = 0;

    /**
     * Scan ITAD pages until enough matching deals are found
     */
    while (collector.needsMore) {
      if (pageNumber > 0) {
        // Small delay to avoid hammering the API
        await new Promise((resolve) =>
          setTimeout(resolve, 200),
        );
      }

      const page = await api.fetchDealsPage({
        ...baseConfig,
        offset,
      });

      /**
       * Temporary debug:
       * print one raw deal from the first page.
       *
       * Useful while configuring filters.
       * We can remove this later.
       */
      if (
        pageNumber === 0 &&
        page.list.length > 0
      ) {
        const sample = page.list[0];

        console.log(
          "\n🔎 Sample first deal:",
          JSON.stringify(
            {
              title: sample.title,
              type: sample.type,
              cut: sample.deal?.cut,
              shop: sample.deal?.shop,
              drm: sample.deal?.drm,
              expiry: sample.deal?.expiry,
              reviews: sample.reviews,
            },
            null,
            2,
          ),
        );
      }

      pageNumber++;

      /**
       * No more results
       */
      if (page.list.length === 0) {
        console.log(
          `Page ${pageNumber}: empty response at offset ${offset}`,
        );
        break;
      }

      totalScanned += page.list.length;

      /**
       * Give each deal to our collector
       */
      for (const deal of page.list) {
        collector.accept(deal);

        if (!collector.needsMore) {
          break;
        }
      }

      const pageStats = collector.stats;

      console.log(
        `Page ${pageNumber}: scanned ${page.list.length} deals at offset ${offset} ` +
          `(accepted ${pageStats.accepted}/${DEAL_LIMIT})`,
      );

      /**
       * Safety:
       * avoid infinite loop if API returns same offset.
       */
      if (page.nextOffset === offset) {
        console.warn(
          "ITAD returned the same offset. Stopping pagination.",
        );
        break;
      }

      offset = page.nextOffset;
    }

    /**
     * Collection results
     */
    const newDeals = collector.results;
    const collectStats = collector.stats;

    console.log("\n✓ Collection complete");
    console.log(
      `   - ITAD results scanned: ${totalScanned}`,
    );
    console.log(
      `   - Accepted: ${collectStats.accepted}`,
    );
    console.log(
      `   - Skipped (already posted): ${collectStats.skippedPosted}`,
    );
    console.log(
      `   - Skipped (filters): ${collectStats.skippedFilter}`,
    );
    console.log(
      `   - Skipped (duplicate in run): ${collectStats.skippedDuplicate}`,
    );

    if (newDeals.length < DEAL_LIMIT) {
      console.warn(
        `Found ${newDeals.length}/${DEAL_LIMIT} new deals after scanning ${totalScanned} ITAD results`,
      );
    }

    /**
     * Nothing found:
     * do NOT post a useless message to Discord.
     */
    if (newDeals.length === 0) {
      console.log(
        "\nNo new deals found matching criteria",
      );

      deduplicationService.markDealsAsPosted([]);

      return;
    }

    /**
     * Stats
     */
    console.log("\n📊 Deal Stats:");

    const stats = deduplicationService.getStats();

    console.log(
      `   - Total tracked deals: ${stats.totalDeals}`,
    );

    console.log(
      `   - New deals to post: ${newDeals.length}`,
    );

    /**
     * Test mode
     */
    if (TEST_MODE) {
      console.log("\n" + "=".repeat(60));
      console.log(
        "TEST MODE - Deals that would be posted:",
      );
      console.log("=".repeat(60));

      const combined = newDeals
        .map(
          (deal, index) =>
            `**${index + 1}.** ${deal.title}\n\n${api.formatDealMessage(
              deal,
            )}`,
        )
        .join("\n---\n");

      if (combined.length > 0) {
        console.log(combined);
      } else {
        console.log("No new deals to display");
      }

      console.log("=".repeat(60));
      console.log(
        "TEST COMPLETE - No deals posted to Discord",
      );
      console.log("=".repeat(60));

      /**
       * Ensure history file exists.
       */
      deduplicationService.markDealsAsPosted([]);

      return;
    }

    /**
     * Discord posting
     */
    console.log("\n📨 Posting to Discord...");

    const fetchedChannel =
      await client.channels.fetch(CHANNEL_ID);

    if (!fetchedChannel) {
      throw new Error(
        `Discord channel ${CHANNEL_ID} was not found`,
      );
    }

    if (!fetchedChannel.isTextBased()) {
      throw new Error(
        `Discord channel ${CHANNEL_ID} is not text based`,
      );
    }

    const channel = fetchedChannel as TextChannel;

    /**
     * Convert deals to Discord embeds
     */
    const embeds = newDeals.map((deal) =>
      api.formatDealEmbed(deal),
    );

    /**
     * Discord allows max 10 embeds per message
     */
    const BATCH_SIZE = 10;

    for (
      let i = 0;
      i < embeds.length;
      i += BATCH_SIZE
    ) {
      const batch = embeds.slice(
        i,
        i + BATCH_SIZE,
      );

      await channel.send({
        embeds: batch as any,
      });

      console.log(
        `Posted embeds ${i + 1}-${Math.min(
          i + BATCH_SIZE,
          embeds.length,
        )}`,
      );

      /**
       * Small delay between Discord messages
       */
      await new Promise((resolve) =>
        setTimeout(resolve, 500),
      );
    }

    /**
     * Record deals as posted
     */
    deduplicationService.markDealsAsPosted(
      newDeals,
    );

    console.log("\n" + "=".repeat(60));
    console.log("✅ All deals posted successfully");
    console.log("=".repeat(60));
  } catch (error) {
    console.error(
      "\n❌ Error posting deals:",
      error,
    );

    throw error;
  }
}

/**
 * Live mode:
 * wait until Discord is ready.
 */
client.once("clientReady", async () => {
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
    console.error("\n❌ Fatal error:", error);
    process.exit(1);
  }

  console.log("\n✅ Job completed, exiting...");

  process.exit(0);
});

/**
 * Test mode does not need Discord login.
 */
if (TEST_MODE) {
  console.log(
    "🧪 TEST_MODE enabled - skipping Discord login\n",
  );

  postDeals()
    .then(() => {
      console.log(
        "\n✅ Test completed successfully",
      );

      process.exit(0);
    })
    .catch((error) => {
      console.error(
        "\n❌ Test failed:",
        error,
      );

      process.exit(1);
    });
} else {
  /**
   * Live Discord login
   */
  client.login(DISCORD_TOKEN);
}
