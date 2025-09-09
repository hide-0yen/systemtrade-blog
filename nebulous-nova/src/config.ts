export const SITE = {
  website: "https://systemtrade.blog/",
  author: "45395",
  profile: "https://systemtrade.blog/",
  desc: "システムトレード構築のために勉強したことをアウトプットするブログです",
  title: "SystemTrade -45395-",
  ogImage: "astropaper-og.jpg",
  lightAndDarkMode: true,
  postPerIndex: 4,
  postPerPage: 4,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true, // show back button in post detail
  editPost: {
    enabled: true,
    text: "Edit page",
    url: "https://github.com/your-username/nebulous-nova/edit/main/", // 実際のGitHubリポジトリURLに変更
  },
  dynamicOgImage: true,
  dir: "ltr", // "rtl" | "auto"
  lang: "ja", // html lang code. Set this empty and default will be "en"
  timezone: "Asia/Tokyo", // Default global timezone (IANA format) https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
} as const;
