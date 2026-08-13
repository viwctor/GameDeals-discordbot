import { EmbedBuilder } from "discord.js";

import {
  ITADConfig,
  ITADDeal,
  ITADDealsResponse,
  ITADGameInfo,
  ITADPopularGame,
} from "../types";

export class ITADApi {
  private baseUrl =
    "https://api.isthereanydeal.com";

  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async fetchDealsPage(
    config: ITADConfig,
  ): Promise<ITADDealsResponse> {
    const requestOffset =
      config.offset || 0;

    const params =
      new URLSearchParams();

    params.append(
      "country",
      config.country || "US",
    );

    params.append(
      "offset",
      requestOffset.toString(),
    );

    params.append(
      "limit",
      (config.limit || 100).toString(),
    );

    params.append(
      "sort",
      config.sort || "-cut",
    );

    params.append(
      "nondeals",
      "false",
    );

    params.append(
      "mature",
      "false",
    );

    if (
      config.shops &&
      config.shops.length > 0
    ) {
      params.append(
        "shops",
        config.shops.join(","),
      );
    }

    /**
     * IMPORTANT:
     *
     * Only discount is filtered by /deals/v2.
     *
     * Steam review filters are intentionally NOT
     * sent here anymore.
     *
     * Review quality will be checked afterwards
     * using /games/info/v2.
     */
    const dealFilter:
      Record<string, unknown> = {};

    if (
      config.minSavings !==
        undefined ||
      config.maxSavings !==
        undefined
    ) {
      dealFilter.cut = {
        min:
          config.minSavings ?? 0,
        max:
          config.maxSavings ??
          null,
      };
    }

    if (
      Object.keys(dealFilter)
        .length > 0
    ) {
      params.append(
        "filter",
        JSON.stringify(dealFilter),
      );
    }

    const url =
      `${this.baseUrl}/deals/v2` +
      `?key=${this.apiKey}` +
      `&${params.toString()}`;

    try {
      const response =
        await fetch(url);

      if (!response.ok) {
        let errorMessage =
          `ITAD API request failed: ` +
          response.status;

        try {
          const errorBody =
            (await response.json()) as {
              status_code?: number;
              reason_phrase?: string;
            };

          if (
            errorBody.status_code !==
              undefined &&
            errorBody.reason_phrase
          ) {
            errorMessage =
              `ITAD API request failed: ` +
              `${errorBody.status_code} ` +
              `${errorBody.reason_phrase}`;
          }
        } catch {
          // Ignore invalid error body
        }

        throw new Error(
          errorMessage,
        );
      }

      const data =
        (await response.json()) as {
          list?: ITADDeal[];
        };

      const list =
        data.list || [];

      return {
        list,
        nextOffset:
          requestOffset +
          list.length,
      };
    } catch (error) {
      console.error(
        "Error fetching deals from ITAD:",
        error,
      );

      throw error;
    }
  }

  /**
   * Get ITAD's most popular games.
   *
   * API allows max 500 per request,
   * so this automatically paginates.
   */
  async getMostPopular(
    requestedLimit: number,
  ): Promise<ITADPopularGame[]> {
    const result:
      ITADPopularGame[] = [];

    let offset = 0;

    console.log(
      `📈 Loading top ${requestedLimit} popular games from ITAD...`,
    );

    while (
      result.length <
      requestedLimit
    ) {
      const remaining =
        requestedLimit -
        result.length;

      const batchLimit =
        Math.min(
          remaining,
          500,
        );

      const url =
        `${this.baseUrl}` +
        `/stats/most-popular/v1` +
        `?key=${this.apiKey}` +
        `&offset=${offset}` +
        `&limit=${batchLimit}`;

      const response =
        await fetch(url);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch ITAD popularity: ${response.status}`,
        );
      }

      const batch =
        (await response.json()) as
          ITADPopularGame[];

      result.push(...batch);

      if (
        batch.length <
        batchLimit
      ) {
        break;
      }

      offset +=
        batch.length;

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            150,
          ),
      );
    }

    console.log(
      `✅ Loaded ${result.length} popular games`,
    );

    return result;
  }

  /**
   * Load detailed information for selected games.
   *
   * This is where Steam reviews, stats and
   * player information come from.
   */
  async getGameInfo(
    gameIds: string[],
  ): Promise<
    Map<string, ITADGameInfo>
  > {
    const result =
      new Map<
        string,
        ITADGameInfo
      >();

    console.log(
      `🔍 Loading detailed info for ${gameIds.length} candidates...`,
    );

    let completed = 0;

    for (
      const gameId of gameIds
    ) {
      try {
        const url =
          `${this.baseUrl}` +
          `/games/info/v2` +
          `?key=${this.apiKey}` +
          `&id=${gameId}`;

        const response =
          await fetch(url);

        if (response.ok) {
          const info =
            (await response.json()) as
              ITADGameInfo;

          result.set(
            gameId,
            info,
          );
        } else {
          console.warn(
            `Game info failed for ${gameId}: ${response.status}`,
          );
        }
      } catch (error) {
        console.error(
          `Error fetching info for game ${gameId}:`,
          error,
        );
      }

      completed++;

      if (
        completed % 10 ===
        0
      ) {
        console.log(
          `   Game info: ${completed}/${gameIds.length}`,
        );
      }

      /**
       * Be polite to ITAD API.
       */
      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            100,
          ),
      );
    }

    console.log(
      `✅ Detailed info loaded for ${result.size}/${gameIds.length} games`,
    );

    return result;
  }

  formatDealMessage(
    deal: ITADDeal,
    info?: ITADGameInfo,
    popularityPosition?: number,
  ): string {
    const price =
      deal.deal.price;

    const regular =
      deal.deal.regular;

    const cut =
      deal.deal.cut;

    let message =
      `**${deal.title}**\n\n`;

    message +=
      `Price: ` +
      `${price.currency} ` +
      `${price.amount.toFixed(2)} ` +
      `(was ${regular.amount.toFixed(2)})\n`;

    message +=
      `Discount: ${cut}% OFF\n`;

    const reviews =
      info?.reviews ??
      deal.reviews ??
      [];

    const steamReview =
      reviews.find(
        (review) =>
          review.source.toLowerCase() ===
          "steam",
      );

    if (steamReview) {
      message +=
        `Steam Rating: ` +
        `${steamReview.score}% ` +
        `(${steamReview.count.toLocaleString()} reviews)\n`;
    }

    if (
      popularityPosition !==
      undefined
    ) {
      message +=
        `ITAD Popularity: #${popularityPosition}\n`;
    }

    const recentPlayers =
      info?.players?.recent;

    if (
      recentPlayers !==
      undefined &&
      recentPlayers > 0
    ) {
      message +=
        `Recent players: ` +
        `${recentPlayers.toLocaleString()}\n`;
    }

    message +=
      `Store: ${deal.deal.shop.name}\n`;

    if (
      deal.deal.flag === "H"
    ) {
      message +=
        `HISTORICAL LOW!\n`;
    }

    message +=
      `Link: ${deal.deal.url}\n\n`;

    return message;
  }

  formatDealEmbed(
    deal: ITADDeal,
    info?: ITADGameInfo,
    popularityPosition?: number,
  ): EmbedBuilder {
    const price =
      deal.deal.price;

    const regular =
      deal.deal.regular;

    const cut =
      deal.deal.cut;

    const shop =
      deal.deal.shop;

    const embed =
      new EmbedBuilder()
        .setTitle(deal.title)
        .setURL(
          deal.deal.url,
        )
        .setColor(
          deal.deal.flag ===
            "H"
            ? 0x00ff99
            : 0x5865f2,
        )
        .addFields(
          {
            name: "Price",
            value:
              `${price.currency} ` +
              `${price.amount.toFixed(2)} ` +
              `(was ${regular.amount.toFixed(2)})`,
            inline: true,
          },
          {
            name:
              "Discount",
            value:
              `${cut}% OFF`,
            inline: true,
          },
          {
            name: "Store",
            value:
              shop.name,
            inline: true,
          },
        );

    if (
      deal.deal.flag === "H"
    ) {
      embed.setDescription(
        "🔥 **HISTORICAL LOW**",
      );
    }

    const reviews =
      info?.reviews ??
      deal.reviews ??
      [];

    const steamReview =
      reviews.find(
        (review) =>
          review.source.toLowerCase() ===
          "steam",
      );

    if (steamReview) {
      embed.addFields({
        name:
          "Steam Rating",
        value:
          `⭐ ${steamReview.score}% ` +
          `(${steamReview.count.toLocaleString()} reviews)`,
        inline: true,
      });
    }

    if (
      popularityPosition !==
      undefined
    ) {
      embed.addFields({
        name:
          "Popularity",
        value:
          `#${popularityPosition} on ITAD`,
        inline: true,
      });
    }

    const recentPlayers =
      info?.players?.recent;

    if (
      recentPlayers !==
        undefined &&
      recentPlayers > 0
    ) {
      embed.addFields({
        name:
          "Players",
        value:
          `${recentPlayers.toLocaleString()} recent`,
        inline: true,
      });
    }

    const assets =
      deal.assets || {};

    if (assets.boxart) {
      embed.setThumbnail(
        assets.boxart,
      );
    } else if (
      assets.banner600
    ) {
      embed.setImage(
        assets.banner600,
      );
    } else if (
      assets.banner300
    ) {
      embed.setImage(
        assets.banner300,
      );
    }

    return embed;
  }
}
