/* @ds-bundle: {"format":4,"namespace":"QueenOfTheSouthFCDesignSystem_f9dc0e","components":[{"name":"ArticleHeader","sourcePath":"components/content/ArticleHeader.jsx"},{"name":"Badge","sourcePath":"components/content/Badge.jsx"},{"name":"NewsListItem","sourcePath":"components/content/NewsListItem.jsx"},{"name":"PageTitle","sourcePath":"components/content/PageTitle.jsx"},{"name":"Panel","sourcePath":"components/content/Panel.jsx"},{"name":"LeagueTable","sourcePath":"components/match/LeagueTable.jsx"},{"name":"Lineup","sourcePath":"components/match/Lineup.jsx"},{"name":"LiveUpdates","sourcePath":"components/match/LiveUpdates.jsx"},{"name":"MatchSummary","sourcePath":"components/match/MatchSummary.jsx"},{"name":"SeasonBar","sourcePath":"components/match/SeasonBar.jsx"},{"name":"MENU_COLUMNS","sourcePath":"components/navigation/MenuOverlay.jsx"},{"name":"MenuOverlay","sourcePath":"components/navigation/MenuOverlay.jsx"},{"name":"NavBar","sourcePath":"components/navigation/NavBar.jsx"},{"name":"PaginationBar","sourcePath":"components/navigation/PaginationBar.jsx"},{"name":"PillTabs","sourcePath":"components/navigation/PillTabs.jsx"}],"sourceHashes":{"components/content/ArticleHeader.jsx":"cee0f0b650f7","components/content/Badge.jsx":"c0738bff1447","components/content/NewsListItem.jsx":"e3c7ea74819a","components/content/PageTitle.jsx":"c9d6fca25e6e","components/content/Panel.jsx":"5c91269b0594","components/match/LeagueTable.jsx":"ce8bc75ecf03","components/match/Lineup.jsx":"eb2300d03ea3","components/match/LiveUpdates.jsx":"b748c06c95aa","components/match/MatchSummary.jsx":"7f475f917e30","components/match/SeasonBar.jsx":"15744cde94f5","components/navigation/MenuOverlay.jsx":"c6636a6f3e7b","components/navigation/NavBar.jsx":"0c064c9d114b","components/navigation/PaginationBar.jsx":"ab039541096a","components/navigation/PillTabs.jsx":"dd0d7d909af1","ui_kits/website/Article.jsx":"165c4821db10","ui_kits/website/Home.jsx":"73228ffe0808","ui_kits/website/MatchReport.jsx":"39d78df866b9","ui_kits/website/NewsList.jsx":"e91386ed6f89","ui_kits/website/Shell.jsx":"ae745a11189a","ui_kits/website/TablePage.jsx":"7f8a0aa7e4d4","ui_kits/website/data.js":"bdfc46ac10bc"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.QueenOfTheSouthFCDesignSystem_f9dc0e = window.QueenOfTheSouthFCDesignSystem_f9dc0e || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/content/Badge.jsx
try { (() => {
function Badge({
  children,
  tone = 'slate'
}) {
  const bg = {
    slate: 'var(--qos-slate)',
    navy: 'var(--qos-navy)',
    sky: 'var(--qos-sky)',
    success: 'var(--success)'
  }[tone] || tone;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      padding: '.25em .6em',
      fontSize: '75%',
      fontWeight: 700,
      lineHeight: 1,
      textAlign: 'center',
      whiteSpace: 'nowrap',
      verticalAlign: 'baseline',
      borderRadius: '10rem',
      background: bg,
      color: '#fff',
      fontFamily: 'var(--font-body)'
    }
  }, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/Badge.jsx", error: String((e && e.message) || e) }); }

// components/content/ArticleHeader.jsx
try { (() => {
function ArticleHeader({
  image,
  category,
  headline,
  date,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      color: 'var(--text-body)'
    }
  }, image && /*#__PURE__*/React.createElement("img", {
    src: image,
    alt: "",
    style: {
      display: 'block',
      width: '100%',
      height: 'auto'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '0 1rem',
      border: '1px solid var(--border-card)',
      position: 'relative',
      top: image ? -112 : 0,
      marginBottom: image ? -112 : 0,
      background: '#fff'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 15
    }
  }, category && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Badge, null, category)), /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: 0,
      fontSize: 28,
      fontWeight: 700,
      lineHeight: 1.2
    }
  }, headline), date && /*#__PURE__*/React.createElement("small", {
    style: {
      color: 'var(--text-muted)',
      fontSize: '80%'
    }
  }, date), /*#__PURE__*/React.createElement("hr", {
    style: {
      margin: '10px 0',
      border: 0,
      borderTop: '1px solid var(--bs-hr)'
    }
  })), children && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '5px 10px 15px',
      lineHeight: 1.5
    }
  }, children)));
}
Object.assign(__ds_scope, { ArticleHeader });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/ArticleHeader.jsx", error: String((e && e.message) || e) }); }

// components/content/NewsListItem.jsx
try { (() => {
function NewsListItem({
  image,
  headline,
  excerpt,
  day,
  month,
  year,
  time,
  onRead
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      color: 'var(--text-body)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,3fr) minmax(0,7fr) minmax(0,2fr)',
      paddingTop: 25
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 15px'
    }
  }, image && /*#__PURE__*/React.createElement("img", {
    src: image,
    alt: "",
    style: {
      width: '100%',
      height: 'auto',
      display: 'block'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 25,
      background: '#fff'
    }
  }, /*#__PURE__*/React.createElement("h5", {
    style: {
      margin: '0 0 8px',
      fontSize: 16,
      fontWeight: 500,
      lineHeight: 1.2
    }
  }, headline), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      lineHeight: 1.5
    }
  }, excerpt), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("a", {
    onClick: onRead,
    style: {
      color: 'var(--link)',
      cursor: 'pointer'
    }
  }, "Read More ...")), /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#fff',
      textAlign: 'right',
      padding: '0 15px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-block',
      textAlign: 'right',
      fontSize: 13,
      color: 'var(--text-body)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'relative',
      top: 7,
      fontSize: 22,
      color: '#666'
    }
  }, day, "/"), /*#__PURE__*/React.createElement("span", {
    style: {
      textTransform: 'uppercase',
      verticalAlign: 'top',
      marginLeft: 6
    }
  }, month), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", null, year), /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#666',
      fontWeight: 700
    }
  }, time)))), /*#__PURE__*/React.createElement("hr", {
    style: {
      margin: '16px 0',
      border: 0,
      borderTop: '1px solid var(--bs-hr)'
    }
  }));
}
Object.assign(__ds_scope, { NewsListItem });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/NewsListItem.jsx", error: String((e && e.message) || e) }); }

// components/content/PageTitle.jsx
try { (() => {
function PageTitle({
  children
}) {
  return /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: 0,
      padding: '25px 0 25px 45px',
      background: 'var(--qos-sky)',
      color: '#fff',
      fontFamily: 'var(--font-display)',
      fontSize: 22,
      fontWeight: 800,
      lineHeight: 1.2
    }
  }, children);
}
Object.assign(__ds_scope, { PageTitle });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/PageTitle.jsx", error: String((e && e.message) || e) }); }

// components/content/Panel.jsx
try { (() => {
function Panel({
  title,
  footer,
  children,
  center = true
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid #ddd',
      borderRadius: 0,
      marginBottom: 20,
      background: '#fff',
      fontFamily: 'var(--font-display)'
    }
  }, title && /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--qos-navy)',
      color: '#fff',
      padding: '10px 15px'
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: 0,
      fontSize: 16,
      fontWeight: 400,
      textAlign: 'center',
      color: '#fff'
    }
  }, title)), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--grey-25)',
      textAlign: center ? 'center' : 'left',
      padding: 5,
      fontSize: 14
    }
  }, children), footer && /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--qos-ice-2)',
      textAlign: 'right',
      padding: '5px 10px',
      color: 'var(--qos-navy)',
      borderTop: '1px solid var(--qos-ice-line)',
      fontSize: 14
    }
  }, footer));
}
Object.assign(__ds_scope, { Panel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/Panel.jsx", error: String((e && e.message) || e) }); }

// components/match/LeagueTable.jsx
try { (() => {
const TINT = {
  1: 'var(--table-champion)',
  2: 'var(--table-playoff)',
  3: 'var(--table-playoff)',
  4: 'var(--table-playoff)',
  9: 'var(--table-playoff-rel)',
  10: 'var(--table-relegated)'
};
function LeagueTable({
  rows = [],
  highlight = 'QOS',
  compact = false,
  note
}) {
  const td = {
    padding: '.75rem',
    borderTop: '1px solid #dee2e6',
    textAlign: 'right',
    fontSize: 16
  };
  const th = {
    ...td,
    background: 'var(--bs-thead-bg)',
    color: 'var(--bs-thead-fg)',
    borderColor: '#dee2e6',
    fontWeight: 700
  };
  const full = !compact;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#fff',
      fontFamily: 'var(--font-body)',
      color: 'var(--text-body)'
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse'
    }
  }, /*#__PURE__*/React.createElement("thead", null, full && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    style: th,
    colSpan: 2
  }, "\xA0"), /*#__PURE__*/React.createElement("td", {
    style: {
      ...th,
      textAlign: 'center'
    },
    colSpan: 4
  }, "Home"), /*#__PURE__*/React.createElement("td", {
    style: {
      ...th,
      textAlign: 'center'
    },
    colSpan: 4
  }, "Away"), /*#__PURE__*/React.createElement("td", {
    style: {
      ...th,
      textAlign: 'center'
    },
    colSpan: 4
  }, "Total")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    style: th
  }, "\xA0"), full && ['P', 'P', 'W', 'D', 'L', 'P', 'W', 'D', 'L', 'F', 'A'].map((h, i) => /*#__PURE__*/React.createElement("td", {
    key: i,
    style: th
  }, h)), /*#__PURE__*/React.createElement("td", {
    style: th
  }, "GD"), /*#__PURE__*/React.createElement("td", {
    style: th
  }, "Pts"))), /*#__PURE__*/React.createElement("tbody", null, rows.map((r, i) => {
    const me = r.club === highlight;
    return /*#__PURE__*/React.createElement("tr", {
      key: r.club,
      style: {
        background: TINT[i + 1] || 'transparent',
        fontWeight: me ? 700 : 400
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        ...td,
        textAlign: 'left'
      }
    }, r.club), full && [r.p, r.hp, r.hw, r.hd, r.hl, r.ap, r.aw, r.ad, r.al, r.f, r.a].map((v, j) => /*#__PURE__*/React.createElement("td", {
      key: j,
      style: td
    }, v)), /*#__PURE__*/React.createElement("td", {
      style: td
    }, r.gd), /*#__PURE__*/React.createElement("td", {
      style: td
    }, r.pts));
  }))), note && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      padding: '0 .75rem 1rem',
      fontSize: 16
    }
  }, note));
}
Object.assign(__ds_scope, { LeagueTable });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/match/LeagueTable.jsx", error: String((e && e.message) || e) }); }

// components/match/Lineup.jsx
try { (() => {
function Lineup({
  pitchSrc = 'assets/pitch-diagram.png',
  rows = [],
  subs = []
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      maxWidth: 360,
      margin: '0 auto',
      aspectRatio: '360/395',
      background: `url(${pitchSrc}) center/cover`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: '6% 0 10%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between'
    }
  }, rows.map((r, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      justifyContent: 'space-around'
    }
  }, r.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.name,
    style: {
      textAlign: 'center',
      color: '#fff',
      fontSize: 12,
      fontWeight: 700,
      textShadow: '0 1px 2px rgba(0,0,0,.6)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 26,
      height: 26,
      borderRadius: '50%',
      background: 'var(--qos-navy)',
      border: '2px solid #fff',
      margin: '0 auto 2px',
      lineHeight: '22px',
      fontSize: 11
    }
  }, p.no), p.name)))))), subs.length > 0 && /*#__PURE__*/React.createElement("p", {
    style: {
      textAlign: 'center',
      color: 'var(--text-muted)',
      fontSize: 14,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("b", null, "Subs:"), " ", subs.join(', ')));
}
Object.assign(__ds_scope, { Lineup });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/match/Lineup.jsx", error: String((e && e.message) || e) }); }

// components/match/LiveUpdates.jsx
try { (() => {
const CELL = {
  kickoff: {
    background: 'var(--update-kickoff)',
    color: '#fff',
    fontWeight: 700
  },
  goalqos: {
    background: 'var(--update-goal-qos)',
    color: '#fff',
    fontWeight: 700
  },
  goalopp: {
    background: 'var(--update-goal-opp)',
    color: '#fff',
    fontWeight: 700
  },
  yellow: {
    background: 'var(--update-yellow)',
    color: '#000',
    fontWeight: 700
  },
  red: {
    background: 'var(--update-red)',
    color: '#fff',
    fontWeight: 700
  },
  sub: {
    background: 'var(--update-sub)',
    color: '#fff',
    fontWeight: 700
  },
  default: {}
};
function LiveUpdates({
  updates = []
}) {
  const td = {
    padding: '.75rem',
    borderTop: '1px solid #dee2e6',
    verticalAlign: 'top',
    fontSize: 16
  };
  return /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      fontFamily: 'var(--font-body)',
      color: 'var(--text-body)'
    }
  }, /*#__PURE__*/React.createElement("tbody", null, updates.map((u, i) => {
    const c = CELL[u.type] || CELL.default;
    return /*#__PURE__*/React.createElement("tr", {
      key: i,
      style: {
        background: i % 2 === 0 ? 'var(--bs-stripe)' : 'transparent'
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        ...td,
        width: 1
      }
    }, u.icon && /*#__PURE__*/React.createElement("img", {
      src: u.icon,
      alt: ""
    })), /*#__PURE__*/React.createElement("td", {
      style: {
        ...td,
        ...c,
        whiteSpace: 'nowrap',
        width: 1
      }
    }, u.time), /*#__PURE__*/React.createElement("td", {
      style: {
        ...td,
        ...c
      }
    }, u.text));
  })));
}
Object.assign(__ds_scope, { LiveUpdates });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/match/LiveUpdates.jsx", error: String((e && e.message) || e) }); }

// components/match/MatchSummary.jsx
try { (() => {
function Crest({
  src
}) {
  return src ? /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: "",
    style: {
      height: 44
    }
  }) : /*#__PURE__*/React.createElement("span", {
    style: {
      width: 44,
      height: 44,
      display: 'inline-block'
    }
  });
}
function MatchSummary({
  date,
  competition,
  home,
  away,
  homeScore,
  awayScore,
  homeLogo,
  awayLogo,
  homeScorers,
  awayScorers
}) {
  const muted = {
    color: 'var(--text-muted)',
    fontSize: '80%'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-body)',
      color: 'var(--text-body)',
      padding: '15px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-around'
    }
  }, /*#__PURE__*/React.createElement("small", {
    style: muted
  }, date), /*#__PURE__*/React.createElement("small", {
    style: muted
  }, competition)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 10,
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: 0,
      fontSize: 32,
      fontWeight: 500
    }
  }, home), /*#__PURE__*/React.createElement(Crest, {
    src: homeLogo
  }), /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: 0,
      fontSize: 40,
      fontWeight: 700
    }
  }, homeScore), /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: '-10px 0 0',
      fontSize: '3rem',
      fontWeight: 500,
      color: 'var(--qos-navy)'
    }
  }, "|"), /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: 0,
      fontSize: 40,
      fontWeight: 700
    }
  }, awayScore), /*#__PURE__*/React.createElement(Crest, {
    src: awayLogo
  }), /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: 0,
      fontSize: 32,
      fontWeight: 500
    }
  }, away)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-around',
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-muted)'
    }
  }, homeScorers), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text-muted)'
    }
  }, awayScorers)));
}
Object.assign(__ds_scope, { MatchSummary });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/match/MatchSummary.jsx", error: String((e && e.message) || e) }); }

// components/match/SeasonBar.jsx
try { (() => {
function SeasonBar({
  label = 'Change Season ',
  seasons = [],
  value,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--qos-mid)',
      textAlign: 'center',
      padding: '15px',
      fontFamily: 'var(--font-body)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#fff',
      marginRight: 4
    }
  }, label), /*#__PURE__*/React.createElement("select", {
    value: value,
    onChange: e => onChange && onChange(e.target.value),
    style: {
      font: 'inherit',
      fontSize: 14
    }
  }, seasons.map(s => /*#__PURE__*/React.createElement("option", {
    key: s,
    value: s
  }, s))));
}
Object.assign(__ds_scope, { SeasonBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/match/SeasonBar.jsx", error: String((e && e.message) || e) }); }

// components/navigation/MenuOverlay.jsx
try { (() => {
const MENU_COLUMNS = [{
  title: 'Teams',
  groups: [{
    h: 'First Team',
    links: ['Fixtures', 'Live Updates', 'Table', 'League Scores', 'Premier Sports Cup', 'Squad', 'Coaches', 'Match Photos']
  }, {
    h: 'Reserves',
    links: ['Squad']
  }, {
    h: 'Youths',
    links: ['U18 Squad']
  }]
}, {
  title: 'Fans',
  groups: [{
    h: null,
    links: ['Prices', 'Tickets', 'Hospitality', 'Get Here']
  }, {
    h: 'Liasons',
    links: ['SLO', 'DAO']
  }, {
    h: 'Contact',
    links: ['Contact Us']
  }]
}, {
  title: 'Club',
  groups: [{
    h: null,
    links: ['Club Policies', 'Safeguarding', 'Our Ground', 'Community Trust', 'Club Staff', 'Vacancies']
  }, {
    h: 'Facilities',
    links: ['Arena Information', 'Book Arena', 'KGV Information', 'Book KGV']
  }, {
    h: 'Articles',
    links: ['Club History', 'Club Legends']
  }]
}, {
  title: 'Commercial',
  groups: [{
    h: null,
    links: ['Shop Online', 'Hospitality']
  }, {
    h: 'Prize Draw',
    links: ['How to Enter', 'Winners']
  }, {
    h: 'Shirt Draw',
    links: ['How To Enter', '26/27 Winners', '26/27 Entrants']
  }, {
    h: 'Sponsorship',
    links: ['Sponsors Brochure']
  }]
}];
function Link({
  children,
  onClick
}) {
  const [h, setH] = React.useState(false);
  return /*#__PURE__*/React.createElement("a", {
    onClick: onClick,
    onMouseEnter: () => setH(true),
    onMouseLeave: () => setH(false),
    style: {
      display: 'block',
      padding: 8,
      fontSize: 16,
      lineHeight: '1rem',
      textDecoration: 'none',
      cursor: 'pointer',
      transition: '0.3s',
      background: h ? '#f8f9fa' : 'transparent',
      color: h ? '#00091c' : '#f8f9fa'
    }
  }, children);
}
function MenuOverlay({
  open = false,
  onClose,
  onLink,
  columns = MENU_COLUMNS,
  position = 'fixed'
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: open ? '100%' : 0,
      width: '100%',
      position,
      zIndex: 20,
      top: 0,
      left: 0,
      background: 'var(--qos-midnight-90)',
      overflowX: 'hidden',
      overflowY: open ? 'auto' : 'hidden',
      transition: '0.5s'
    }
  }, /*#__PURE__*/React.createElement("a", {
    onClick: onClose,
    style: {
      position: 'absolute',
      top: 20,
      right: 45,
      fontSize: 60,
      color: '#f8f9fa',
      textDecoration: 'none',
      cursor: 'pointer',
      lineHeight: 1
    }
  }, "\xD7"), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      top: '10%',
      marginTop: 50,
      textAlign: 'center',
      textTransform: 'uppercase',
      fontFamily: 'var(--font-body)',
      padding: '0 15px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))',
      margin: '0 5px'
    }
  }, columns.map(c => /*#__PURE__*/React.createElement("div", {
    key: c.title,
    style: {
      background: '#00091c',
      border: '1px solid #6c757d',
      padding: '25px 15px 15px'
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: '0 0 8px',
      padding: '15px 0',
      fontWeight: 700,
      fontSize: 32,
      background: '#f8f9fa',
      color: '#00091c'
    }
  }, c.title), c.groups.map((g, i) => /*#__PURE__*/React.createElement("div", {
    key: i
  }, g.h && /*#__PURE__*/React.createElement("h4", {
    style: {
      margin: '10px 0 0',
      padding: '5px 0',
      fontSize: 24,
      fontWeight: 500,
      background: '#3068a7',
      color: '#f8f9fa'
    }
  }, g.h), g.links.map(l => /*#__PURE__*/React.createElement(Link, {
    key: l,
    onClick: () => onLink && onLink(l)
  }, l)))))))));
}
Object.assign(__ds_scope, { MENU_COLUMNS, MenuOverlay });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/MenuOverlay.jsx", error: String((e && e.message) || e) }); }

// components/navigation/NavBar.jsx
try { (() => {
const LINKS = [['news', 'News'], ['fixtures', 'Fixtures'], ['tickets', 'Tickets'], ['updates', 'Updates']];
function NavBar({
  scrolled = false,
  active,
  onMenu,
  onNavigate,
  crestSrc = 'assets/logo/qos-crest.png',
  position = 'fixed'
}) {
  const [hover, setHover] = React.useState(null);
  const link = k => ({
    color: hover === k || active === k ? '#3068a7' : '#fff',
    textDecoration: 'none',
    lineHeight: '65px',
    fontWeight: 700,
    textTransform: 'uppercase',
    fontFamily: 'var(--font-body)',
    fontSize: 16,
    cursor: 'pointer'
  });
  return /*#__PURE__*/React.createElement("nav", {
    style: {
      position,
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10,
      height: 65,
      lineHeight: '65px',
      paddingTop: scrolled ? 0 : 20,
      paddingBottom: scrolled ? 0 : 20,
      background: scrolled ? 'var(--qos-navy)' : 'transparent',
      transition: 'all 0.4s ease',
      boxSizing: 'content-box',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("a", {
    onClick: () => onNavigate && onNavigate('home'),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      paddingLeft: '3rem',
      color: '#fff',
      textDecoration: 'none',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: crestSrc,
    alt: "Queen of the South",
    style: {
      height: 60
    }
  }), scrolled && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 16
    }
  }, "Official Website")), /*#__PURE__*/React.createElement("div", {
    style: {
      background: scrolled ? 'inherit' : 'var(--glass-dark)',
      marginRight: 45
    }
  }, /*#__PURE__*/React.createElement("ul", {
    style: {
      display: 'flex',
      listStyle: 'none',
      margin: 0,
      padding: '0 0 0 20px'
    }
  }, /*#__PURE__*/React.createElement("li", {
    style: {
      paddingRight: '1rem'
    }
  }, /*#__PURE__*/React.createElement("a", {
    style: link('menu'),
    onMouseEnter: () => setHover('menu'),
    onMouseLeave: () => setHover(null),
    onClick: onMenu
  }, scrolled && /*#__PURE__*/React.createElement("span", null, "MENU "), "\u2630")), LINKS.map(([k, l]) => /*#__PURE__*/React.createElement("li", {
    key: k,
    style: {
      paddingRight: '1rem'
    }
  }, /*#__PURE__*/React.createElement("a", {
    style: link(k),
    onMouseEnter: () => setHover(k),
    onMouseLeave: () => setHover(null),
    onClick: () => onNavigate && onNavigate(k)
  }, l))), /*#__PURE__*/React.createElement("li", {
    style: {
      paddingRight: '1rem',
      paddingTop: 5
    }
  }, /*#__PURE__*/React.createElement("a", {
    style: link('shop'),
    onMouseEnter: () => setHover('shop'),
    onMouseLeave: () => setHover(null),
    onClick: () => onNavigate && onNavigate('shop')
  }, /*#__PURE__*/React.createElement("i", {
    className: "fa fa-2x fa-shopping-cart",
    "aria-hidden": "true"
  }))))));
}
Object.assign(__ds_scope, { NavBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/NavBar.jsx", error: String((e && e.message) || e) }); }

// components/navigation/PaginationBar.jsx
try { (() => {
function PaginationBar({
  label,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled
}) {
  const btn = {
    font: 'inherit',
    fontSize: 16,
    padding: '1px 6px',
    cursor: 'pointer'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      alignItems: 'center',
      padding: 25,
      marginTop: 25,
      background: 'var(--qos-sky)',
      fontFamily: 'var(--font-body)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: btn,
    disabled: prevDisabled,
    onClick: onPrev
  }, ' << ')), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      color: '#fff',
      fontWeight: 700
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: btn,
    disabled: nextDisabled,
    onClick: onNext
  }, ' >> ')));
}
Object.assign(__ds_scope, { PaginationBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/PaginationBar.jsx", error: String((e && e.message) || e) }); }

// components/navigation/PillTabs.jsx
try { (() => {
function PillTabs({
  items = [],
  active,
  onChange
}) {
  return /*#__PURE__*/React.createElement("ul", {
    style: {
      display: 'flex',
      listStyle: 'none',
      margin: 0,
      padding: 0,
      fontFamily: 'var(--font-body)'
    }
  }, items.map(it => {
    const on = it === active;
    return /*#__PURE__*/React.createElement("li", {
      key: it,
      style: {
        flex: '1 1 auto',
        textAlign: 'center'
      }
    }, /*#__PURE__*/React.createElement("a", {
      onClick: () => onChange && onChange(it),
      style: {
        display: 'block',
        padding: '.5rem 1rem',
        borderRadius: '.25rem',
        cursor: 'pointer',
        textDecoration: 'none',
        fontSize: 16,
        background: on ? 'var(--bs-primary)' : 'transparent',
        color: on ? '#fff' : 'var(--bs-primary)'
      }
    }, it));
  }));
}
Object.assign(__ds_scope, { PillTabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/PillTabs.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Article.jsx
try { (() => {
function Article({
  id,
  go
}) {
  const a = window.QOS_DATA.news.find(n => n.id === id) || window.QOS_DATA.news[0];
  return /*#__PURE__*/React.createElement(Container, {
    style: {
      paddingBottom: 25
    }
  }, /*#__PURE__*/React.createElement(ArticleHeader, {
    image: a.img,
    category: a.cat,
    headline: a.headline,
    date: a.month + ' ' + a.day + ' ' + a.year + ' ' + a.time
  }, /*#__PURE__*/React.createElement("p", null, a.excerpt), /*#__PURE__*/React.createElement("p", null, "Queens started brightly in front of the home support at Palmerston and deserved the lead when Paton found the bottom corner midway through the first half."), /*#__PURE__*/React.createElement("p", null, "Cove levelled after the break but captain Todd restored the advantage from a corner with 19 minutes remaining, and Queens saw the game out to move second in the table."), /*#__PURE__*/React.createElement("p", null, /*#__PURE__*/React.createElement("a", {
    style: {
      color: 'var(--link)',
      cursor: 'pointer'
    },
    onClick: () => go('report')
  }, "Match report, lineup and updates"))));
}
Object.assign(window, {
  Article
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Article.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Home.jsx
try { (() => {
function NewsCarousel({
  go
}) {
  const n = window.QOS_DATA.news;
  const [i, setI] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setI(x => (x + 1) % n.length), 5000);
    return () => clearInterval(t);
  }, []);
  const a = n[i];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      aspectRatio: '16/9',
      background: `url(${a.img}) center/cover`,
      cursor: 'pointer'
    },
    onClick: () => go('article', a.id)
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,.5)',
      color: '#fff',
      padding: '12px 15px',
      fontFamily: 'var(--font-display)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 800
    }
  }, a.headline), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      opacity: .85,
      marginTop: 4,
      fontFamily: 'var(--font-body)'
    }
  }, a.excerpt)), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 10,
      right: 10,
      display: 'flex',
      gap: 6
    }
  }, n.map((_, k) => /*#__PURE__*/React.createElement("span", {
    key: k,
    onClick: e => {
      e.stopPropagation();
      setI(k);
    },
    style: {
      width: 10,
      height: 10,
      borderRadius: '50%',
      background: k === i ? '#009fff' : 'rgba(255,255,255,.7)'
    }
  }))));
}
function Home({
  go
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 15px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)',
      gap: 15
    }
  }, /*#__PURE__*/React.createElement(NewsCarousel, {
    go: go
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      paddingTop: '1em'
    }
  }, /*#__PURE__*/React.createElement(WidgetSlot, {
    label: "Next match countdown (Elfsight)",
    height: '100%'
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0,3fr) minmax(0,1fr)',
      gap: 15,
      marginTop: 15
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/banners/nextmatchbanner-split.jpg",
    style: {
      width: '100%',
      display: 'block',
      marginBottom: 15,
      cursor: 'pointer'
    },
    onClick: () => go('tickets')
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 15
    }
  }, /*#__PURE__*/React.createElement(Panel, null, /*#__PURE__*/React.createElement(WidgetSlot, {
    label: "QOSTV on YouTube (Elfsight)",
    height: 320
  })), /*#__PURE__*/React.createElement(Panel, null, /*#__PURE__*/React.createElement(WidgetSlot, {
    label: "QOS & Community Trust social wall (Elfsight)",
    height: 320
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, ['trust_saturdayclub', 'trust_wednesdayclub', 'trust_girlsfootball'].map(s => /*#__PURE__*/React.createElement("img", {
    key: s,
    src: '../../assets/ads/' + s + '.jpg',
    style: {
      width: '100%',
      display: 'block'
    }
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 15,
      background: '#F2F8FF',
      borderTop: '1px solid #094582',
      padding: '15px 0',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/banners/league-1-stacked.jpg",
    style: {
      height: 70
    }
  })));
}
Object.assign(window, {
  Home
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Home.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/MatchReport.jsx
try { (() => {
function MatchReport({
  go
}) {
  const [tab, setTab] = React.useState('Report');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#f7f7f7',
      color: '#333',
      paddingBottom: 45
    }
  }, /*#__PURE__*/React.createElement(Container, {
    style: {
      paddingTop: 15
    }
  }, /*#__PURE__*/React.createElement(MatchSummary, {
    date: "Saturday 4th October 2026",
    competition: "SPFL League One",
    home: "Queen of the South",
    away: "Cove Rangers",
    homeScore: 2,
    awayScore: 1,
    homeLogo: "../../assets/logo/qos-crest.png",
    homeScorers: "Paton 23', Todd 71'",
    awayScorers: "Megginson 55'"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1140,
      margin: '0 auto',
      background: '#fff',
      padding: 15
    }
  }, /*#__PURE__*/React.createElement(PillTabs, {
    items: ['Report', 'Lineup', 'Updates'],
    active: tab,
    onChange: setTab
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      paddingTop: 25,
      lineHeight: 1.5
    }
  }, tab === 'Report' && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", null, "Queens moved up to second in League One with a hard-fought win over Cove Rangers at Palmerston."), /*#__PURE__*/React.createElement("p", null, "Paton opened the scoring on 23 minutes, setting himself on the edge of the box before driving low into the corner. Cove drew level ten minutes after the restart, but captain Todd headed home from a corner on 71 minutes to settle it.")), tab === 'Lineup' && /*#__PURE__*/React.createElement(Lineup, {
    pitchSrc: "../../assets/pitch-diagram.png",
    rows: [[{
      no: 9,
      name: 'Paton'
    }, {
      no: 10,
      name: 'Dykes'
    }], [{
      no: 7,
      name: 'Wilson'
    }, {
      no: 8,
      name: 'Todd'
    }, {
      no: 6,
      name: 'East'
    }, {
      no: 11,
      name: 'Reid'
    }], [{
      no: 2,
      name: 'Gibson'
    }, {
      no: 5,
      name: 'Brown'
    }, {
      no: 4,
      name: 'Hall'
    }, {
      no: 3,
      name: 'Kerr'
    }], [{
      no: 1,
      name: 'Ross'
    }]],
    subs: ['Wilson (64\' for Dykes)', 'Murray', 'Hendrie']
  }), tab === 'Updates' && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h5", {
    style: {
      fontSize: 16,
      fontWeight: 500
    }
  }, "For Real Time Updates Go To Our ", /*#__PURE__*/React.createElement("a", {
    style: {
      color: 'var(--link)',
      cursor: 'pointer'
    },
    onClick: () => go('updates')
  }, "Updates Page")), /*#__PURE__*/React.createElement(LiveUpdates, {
    updates: window.QOS_DATA.updates
  })))));
}
Object.assign(window, {
  MatchReport
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/MatchReport.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/NewsList.jsx
try { (() => {
function NewsList({
  go
}) {
  const [p, setP] = React.useState(1);
  return /*#__PURE__*/React.createElement(Container, null, /*#__PURE__*/React.createElement(PageTitle, null, "Latest News"), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 25,
      background: '#fff'
    }
  }, window.QOS_DATA.news.map(n => /*#__PURE__*/React.createElement(NewsListItem, {
    key: n.id,
    image: n.img,
    headline: n.headline,
    excerpt: n.excerpt,
    day: n.day,
    month: n.month,
    year: n.year,
    time: n.time,
    onRead: () => go('article', n.id)
  }))), /*#__PURE__*/React.createElement(PaginationBar, {
    label: 'Page ' + p + ' of 14',
    prevDisabled: p === 1,
    onPrev: () => setP(p - 1),
    onNext: () => setP(p + 1)
  }));
}
Object.assign(window, {
  NewsList
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/NewsList.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/Shell.jsx
try { (() => {
const {
  NavBar,
  MenuOverlay,
  Panel,
  PageTitle,
  NewsListItem,
  PaginationBar,
  ArticleHeader,
  MatchSummary,
  PillTabs,
  LiveUpdates,
  Lineup,
  SeasonBar,
  LeagueTable
} = window.QueenOfTheSouthFCDesignSystem_f9dc0e;
function Shell({
  page,
  go,
  children
}) {
  const [scrolled, setScrolled] = React.useState(false);
  const [menu, setMenu] = React.useState(false);
  React.useEffect(() => {
    const f = () => setScrolled(window.scrollY > 50);
    window.addEventListener('scroll', f);
    return () => window.removeEventListener('scroll', f);
  }, []);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: '100vh',
      background: 'var(--surface-page)'
    }
  }, /*#__PURE__*/React.createElement(NavBar, {
    scrolled: scrolled,
    active: page,
    crestSrc: "../../assets/logo/qos-crest.png",
    onMenu: () => setMenu(true),
    onNavigate: k => {
      go(k);
      setMenu(false);
    }
  }), /*#__PURE__*/React.createElement(MenuOverlay, {
    open: menu,
    onClose: () => setMenu(false),
    onLink: l => {
      const m = {
        'Table': 'table',
        'Fixtures': 'fixtures',
        'Live Updates': 'updates',
        'Tickets': 'tickets'
      };
      setMenu(false);
      go(m[l] || 'news');
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 110,
      background: page === 'home' ? 'transparent' : '#fff'
    }
  }, children), /*#__PURE__*/React.createElement(WidgetSlot, {
    label: "Footer (Elfsight widget)",
    height: 120,
    dark: true
  }));
}
function WidgetSlot({
  label,
  height = 200,
  dark
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: '1px dashed ' + (dark ? '#3068a7' : '#c9d7e4'),
      background: dark ? '#083d72' : '#fdfdfd',
      color: dark ? '#b7c7f1' : '#6c757d',
      fontSize: 13,
      fontFamily: 'var(--font-body)',
      textAlign: 'center',
      padding: 10
    }
  }, label, " \u2014 third-party embed, not recreated");
}
function Container({
  children,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1140,
      margin: '0 auto',
      padding: '25px 15px 0',
      ...style
    }
  }, children);
}
Object.assign(window, {
  Shell,
  WidgetSlot,
  Container
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/Shell.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/TablePage.jsx
try { (() => {
function TablePage() {
  const [s, setS] = React.useState('2025/26');
  return /*#__PURE__*/React.createElement(Container, {
    style: {
      paddingBottom: 25
    }
  }, /*#__PURE__*/React.createElement(PageTitle, null, "SPFL League One Table 25/26"), /*#__PURE__*/React.createElement(SeasonBar, {
    seasons: ['2025/26', '2024/25', '2023/24'],
    value: s,
    onChange: setS
  }), /*#__PURE__*/React.createElement(LeagueTable, {
    rows: window.QOS_DATA.table,
    note: "ICT DEDUCTED 5 POINTS"
  }));
}
function WidgetPage({
  title,
  label
}) {
  return /*#__PURE__*/React.createElement(Container, {
    style: {
      paddingBottom: 25
    }
  }, /*#__PURE__*/React.createElement(PageTitle, null, title), /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#fff',
      padding: 25
    }
  }, /*#__PURE__*/React.createElement(WidgetSlot, {
    label: label,
    height: 360
  })));
}
Object.assign(window, {
  TablePage,
  WidgetPage
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/TablePage.jsx", error: String((e && e.message) || e) }); }

// ui_kits/website/data.js
try { (() => {
window.QOS_DATA = {
  news: [{
    id: 1,
    cat: 'First Team',
    img: '../../assets/photos/match-todd.jpg',
    headline: 'Queens Edge Past Cove at Palmerston',
    excerpt: 'Goals from Paton and Todd earned the Doonhamers all three points against Cove Rangers on Saturday afternoon.',
    day: 4,
    month: 'Oct',
    year: 2026,
    time: '17:10'
  }, {
    id: 2,
    cat: 'Tickets',
    img: '../../assets/photos/match-paton.jpg',
    headline: 'Ticket Info: Alloa Athletic (A)',
    excerpt: 'Tickets for our trip to the Indodrill Stadium are available to buy online now.',
    day: 3,
    month: 'Oct',
    year: 2026,
    time: '12:00'
  }, {
    id: 3,
    cat: 'First Team',
    img: '../../assets/photos/match-dykes.jpg',
    headline: 'Match Preview: Queens v Cove Rangers',
    excerpt: 'Everything you need to know ahead of Saturday\'s League One clash at Palmerston Park.',
    day: 2,
    month: 'Oct',
    year: 2026,
    time: '09:30'
  }, {
    id: 4,
    cat: 'Community',
    img: '../../assets/photos/match-wilson.jpg',
    headline: 'Community Trust Saturday Club Returns',
    excerpt: 'The Saturday Club is back at the Arena every week from 10am. Contact the Trust to book a place.',
    day: 1,
    month: 'Oct',
    year: 2026,
    time: '14:45'
  }],
  table: [['Cove Rangers', 9, 16, 8], ['QOS', 9, 14, 6], ['Alloa', 9, 13, 4], ['Montrose', 9, 12, 3], ['Stenhousemuir', 9, 11, 1], ['Kelty Hearts', 9, 10, -1], ['Inverness CT', 9, 9, -2], ['Peterhead', 9, 7, -4], ['East Fife', 9, 6, -6], ['Annan', 9, 4, -9]].map(([club, p, pts, gd]) => ({
    club,
    p,
    pts,
    gd,
    hp: Math.ceil(p / 2),
    hw: Math.round(pts / 6),
    hd: 1,
    hl: 1,
    ap: Math.floor(p / 2),
    aw: Math.round(pts / 7),
    ad: 1,
    al: 1,
    f: 10 + gd,
    a: 10
  })),
  updates: [{
    time: "0'",
    text: 'We are under way at Palmerston.',
    type: 'kickoff'
  }, {
    time: "8'",
    text: 'Early pressure from Queens, corner cleared.'
  }, {
    time: "23'",
    text: 'GOAL! Paton sets himself and fires into the bottom corner. 1-0.',
    type: 'goalqos'
  }, {
    time: "40'",
    text: 'Todd booked for a late challenge.',
    type: 'yellow'
  }, {
    time: "45'",
    text: 'Half time. Queens 1-0 Cove.'
  }, {
    time: "55'",
    text: 'Cove level through Megginson.',
    type: 'goalopp'
  }, {
    time: "64'",
    text: 'Wilson replaces Dykes.',
    type: 'sub'
  }, {
    time: "71'",
    text: 'GOAL! Captain Todd heads home from the corner. 2-1.',
    type: 'goalqos'
  }, {
    time: "90+4'",
    text: 'Full time. Queens 2-1 Cove Rangers.'
  }]
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/website/data.js", error: String((e && e.message) || e) }); }

__ds_ns.ArticleHeader = __ds_scope.ArticleHeader;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.NewsListItem = __ds_scope.NewsListItem;

__ds_ns.PageTitle = __ds_scope.PageTitle;

__ds_ns.Panel = __ds_scope.Panel;

__ds_ns.LeagueTable = __ds_scope.LeagueTable;

__ds_ns.Lineup = __ds_scope.Lineup;

__ds_ns.LiveUpdates = __ds_scope.LiveUpdates;

__ds_ns.MatchSummary = __ds_scope.MatchSummary;

__ds_ns.SeasonBar = __ds_scope.SeasonBar;

__ds_ns.MENU_COLUMNS = __ds_scope.MENU_COLUMNS;

__ds_ns.MenuOverlay = __ds_scope.MenuOverlay;

__ds_ns.NavBar = __ds_scope.NavBar;

__ds_ns.PaginationBar = __ds_scope.PaginationBar;

__ds_ns.PillTabs = __ds_scope.PillTabs;

})();
