import { describe, expect, it } from "vitest";

import { cleanCampaignTag, cleanReferrerHost, visitSourceFrom } from "./visitSource";

describe("visit source", () => {
  it("keeps a referring site's host and drops this website", () => {
    expect(cleanReferrerHost("WWW.Google.com", "scientfactory.com")).toBe("google.com");
    expect(cleanReferrerHost("com.google.android.gm", "scientfactory.com")).toBe(
      "com.google.android.gm",
    );
    expect(cleanReferrerHost("www.scientfactory.com", "scientfactory.com")).toBeNull();
    expect(cleanReferrerHost("https://google.com/search?q=x", "scientfactory.com")).toBeNull();
    expect(cleanReferrerHost(42, "scientfactory.com")).toBeNull();
  });

  it("keeps short campaign labels and drops addresses and emails", () => {
    expect(cleanCampaignTag(" spring-launch_2026 ")).toBe("spring-launch_2026");
    expect(cleanCampaignTag("LinkedIn | paid")).toBe("LinkedIn | paid");
    expect(cleanCampaignTag("someone@example.com")).toBeNull();
    expect(cleanCampaignTag("https://example.com")).toBeNull();
    expect(cleanCampaignTag("/private/path")).toBeNull();
    expect(cleanCampaignTag("x".repeat(101))).toBeNull();
  });

  it("reads every field through the same checks", () => {
    const values: Record<string, string> = {
      referrer_host: "x.com",
      utm_source: "twitter",
      utm_medium: "social",
      utm_campaign: "bad<script>",
      landing_path: "/docs?token=secret",
    };
    expect(visitSourceFrom((name) => values[name], "scientfactory.com")).toEqual({
      referrerHost: "x.com",
      utmSource: "twitter",
      utmMedium: "social",
      utmCampaign: null,
      landingPath: "/docs",
    });
  });
});
