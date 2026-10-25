export type Contact = {
  name: string;
  email: string | null;
  url: string;
  verifiedAt: string | null;
  phone?: string;
};
const contacts: Record<string, Contact> = {
  hackensack: {
    name: "Hackensack Public Works",
    email: "dpw@hackensack.org",
    url: "https://www.hackensack.org/public-works-sanitation-recycling/",
    verifiedAt: "2026-10-12",
    phone: "201-646-3951",
  },
  paramus: {
    name: "Paramus Public Works",
    email: "dpw@paramusborough.gov",
    url: "https://www.paramusborough.gov/m/directory/department?did=26",
    verifiedAt: "2026-10-12",
  },
  lodi: {
    name: "Lodi Public Works",
    email: "BPaladino@Lodi-NJ.org",
    url: "https://www.lodi-nj.org/p/public-works",
    verifiedAt: "2026-10-12",
    phone: "973-365-4068",
  },
  "fair lawn": {
    name: "Fair Lawn Public Works",
    email: "dpw@fairlawn.org",
    url: "https://www.fairlawnnj.govoffice.com/dpw",
    verifiedAt: "2026-10-12",
  },
  "river edge": {
    name: "River Edge Public Works",
    email: null,
    url: "https://www.riveredgenj.org/departments/",
    verifiedAt: "2026-10-12",
    phone: "201-599-6275",
  },
  teaneck: {
    name: "Teaneck Public Works",
    email: null,
    url: "https://www.teanecknj.gov/our-government/service-directory/",
    verifiedAt: "2026-10-12",
    phone: "201-837-1600",
  },
  maywood: {
    name: "Maywood Public Works",
    email: "mmorrigan@maywoodboro.org",
    url: "https://www.maywoodnj.com/?SEC=A5304E90-E284-4B80-A330-EBA54CCC3383",
    verifiedAt: "2026-10-12",
    phone: "201-845-2900",
  },
  "rochelle park": {
    name: "Rochelle Park Public Works",
    email: "DPW2@rochelleparknj.gov",
    url: "https://rochelleparknj.gov/telephone-and-email-directory/",
    verifiedAt: "2026-10-12",
    phone: "201-587-7730",
  },
  "new milford": {
    name: "New Milford Public Works",
    email: "vcahill@newmilfordnj.gov",
    url: "https://www.newmilfordnj.gov/page/contact-directory",
    verifiedAt: "2026-10-12",
    phone: "201-967-8172",
  },
};
export function cleanTown(name: string) {
  return /^Washington Township$/i.test(name)
    ? "Washington Township"
    : name.replace(/\s+(borough|city|township|town|village)$/i, "").trim();
}
// Statewide fallback: the State of New Jersey's directory of municipal governments.
export const NJ_MUNICIPAL_DIRECTORY = "https://www.nj.gov/nj/gov/county/localgov.shtml";
/** "Hackensack, Bergen County" -> town and county. Older reports stored only Bergen town names. */
export function splitMunicipality(label: string) {
  const m = label.match(/^(.*), ([A-Za-z ]+) County$/);
  return m ? { town: m[1], county: m[2] } : { town: label, county: "Bergen" };
}
export function contactFor(name: string): Contact {
  const { town: raw, county } = splitMunicipality(name);
  const town = cleanTown(raw);
  if (county.toLowerCase() !== "bergen")
    return {
      name: `${town} municipal contact`,
      email: null,
      url: NJ_MUNICIPAL_DIRECTORY,
      verifiedAt: null,
    };
  const key = town.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    contacts[town.toLowerCase()] ?? {
      name: `${town} municipal contact`,
      email: null,
      url: (directory.links as Record<string, string>)[key] ?? directory.source,
      verifiedAt: null,
    }
  );
}
import directory from "@/data/municipal-links.json";
