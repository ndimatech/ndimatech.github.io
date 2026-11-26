// What the shop sells. Prices are in cents, VAT not charged (NdimaTech is not VAT registered).
export const PRODUCTS = {
  "popia-it-toolkit": {
    name: "POPIA IT Toolkit for Small and Medium Practices",
    amountCents: 99500,
    file: "NdimaTech-POPIA-IT-Toolkit.zip",        // object key in the R2 bucket (FILES)
    downloadName: "NdimaTech-POPIA-IT-Toolkit.zip", // file name the buyer sees
    page: "/popia-toolkit.html",
  },
  // R10 live test of the whole flow (payment, webhook, emails, download). Not on any page, and only sold to
  // NdimaTech's own address, so nobody else can use it to get the toolkit for R10.
  "test-r10": {
    name: "TEST purchase: POPIA IT Toolkit",
    amountCents: 1000,
    file: "NdimaTech-POPIA-IT-Toolkit.zip",
    downloadName: "NdimaTech-POPIA-IT-Toolkit.zip",
    page: "/popia-toolkit.html",
    onlyEmail: "setup@ndimatech.co.za",
  },
};

export const DOWNLOAD_DAYS = 30;     // a download link works for this many days
export const MAX_DOWNLOADS = 10;     // and this many times
export const MAX_RESENDS = 3;        // buyer can ask for a fresh link this many times
