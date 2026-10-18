//! Node.js bindings to rpfm_lib used by the TW Lua Debugger VS Code extension:
//! reading Lua files out of the game's pack files and building mod packs.

#![deny(clippy::all)]

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::RegexSetBuilder;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use rpfm_lib::files::pack::Pack;
use rpfm_lib::error::RLibError;
use rpfm_lib::files::table::DecodedData;
use rpfm_lib::files::db::DB;
use rpfm_lib::files::loc::Loc;
use rpfm_lib::files::{Container, DecodeableExtraData, Encodeable, EncodeableExtraData, FileType, RFile, RFileDecoded};
use rpfm_lib::schema::{Definition, DefinitionPatch, FieldType, Schema};
use rpfm_lib::games::pfh_file_type::PFHFileType;
use rpfm_lib::games::supported_games::SupportedGames;
use rpfm_lib::games::GameInfo;

fn supported_games() -> &'static SupportedGames {
    static GAMES: OnceLock<SupportedGames> = OnceLock::new();
    GAMES.get_or_init(SupportedGames::default)
}

fn game_info(key: &str) -> Result<&'static GameInfo> {
    supported_games()
        .game(key)
        .ok_or_else(|| Error::from_reason(format!("Unknown game key '{key}'")))
}

fn to_napi<E: std::fmt::Display>(context: &str) -> impl FnOnce(E) -> Error + '_ {
    move |e| Error::from_reason(format!("{context}: {e}"))
}

/// Merges packs like the game: packs are grouped by type (game packs, then
/// mods, then movie packs; a later group overrides an earlier one) and within a
/// group the FIRST pack wins. With `keep_order` false the packs of a group are
/// first sorted by file name (RPFM's model of the default load order);
/// with true, the given order is the priority order.
fn open(paths: &[String], game: &str, keep_order: bool) -> Result<Pack> {
    let info = game_info(game)?;
    let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    Pack::read_and_merge(&paths, info, true, false, keep_order).map_err(to_napi("Could not open packs"))
}

/// A set of packs merged into one (see `open` for which file wins).
#[napi]
pub struct PackHolder {
    pack: Pack,
}

/// Translates a glob (relative to the pack root, any case) to a regex:
/// `**` any folders, `*` and `?` within a name, `{a,b}` alternatives. A pattern
/// without `/` matches a name in any folder, as in .gitignore. A folder also
/// matches what is inside it.
fn glob_to_regex(glob: &str) -> String {
    let glob = glob.trim().trim_start_matches('/');
    let mut re = String::from(if glob.contains('/') { "^" } else { "^(?:.*/)?" });
    let chars: Vec<char> = glob.chars().collect();
    let mut i = 0;
    let mut in_braces = false;
    while i < chars.len() {
        match chars[i] {
            '*' if chars.get(i + 1) == Some(&'*') => {
                if chars.get(i + 2) == Some(&'/') {
                    re.push_str("(?:.*/)?");
                    i += 1;
                } else {
                    re.push_str(".*");
                }
                i += 1;
            }
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            '{' => {
                in_braces = true;
                re.push_str("(?:");
            }
            '}' if in_braces => {
                in_braces = false;
                re.push(')');
            }
            ',' if in_braces => re.push('|'),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    re.push_str("(?:/.*)?$");
    re
}

/// The folders of a set of paths: lower-case folder path -> its files and
/// folders, sorted. Only folders with a file left after `exclude` appear.
fn build_tree(paths: &[String], exclude: &[String]) -> Result<HashMap<String, Vec<DirEntry>>> {
    let exclude = RegexSetBuilder::new(exclude.iter().filter(|g| !g.trim().is_empty()).map(|g| glob_to_regex(g)))
        .case_insensitive(true)
        .build()
        .map_err(to_napi("Invalid filter pattern"))?;
    // lower-case folder -> lower-case name -> entry
    let mut dirs: HashMap<String, BTreeMap<String, DirEntry>> = HashMap::new();
    dirs.insert(String::new(), BTreeMap::new());
    for path in paths {
        if exclude.is_match(path) {
            continue;
        }
        let mut parent = String::new();
        let mut parts = path.split('/').peekable();
        while let Some(part) = parts.next() {
            let is_dir = parts.peek().is_some();
            let lower = part.to_lowercase();
            dirs.entry(parent.clone()).or_default().entry(lower.clone())
                .or_insert_with(|| DirEntry { name: part.to_owned(), is_dir });
            if is_dir {
                if !parent.is_empty() {
                    parent.push('/');
                }
                parent.push_str(&lower);
            }
        }
    }
    Ok(dirs.into_iter().map(|(dir, entries)| (dir, entries.into_values().collect())).collect())
}

/// The folders of a pack, possibly filtered (see `PackHolder.dirTreeAsync`).
#[napi]
pub struct DirTree {
    dirs: HashMap<String, Vec<DirEntry>>,
}

#[napi]
impl DirTree {
    /// The files and folders in a folder (`""` for the root; any case), sorted by
    /// name; null when there is no such folder (or nothing in it passes the filter).
    #[napi]
    pub fn list_dir(&self, dir: String) -> Option<Vec<DirEntry>> {
        self.dirs.get(&dir.trim_matches('/').to_lowercase()).cloned()
    }
}

pub struct DirTreeTask {
    paths: Vec<String>,
    exclude: Vec<String>,
}

impl Task for DirTreeTask {
    type Output = HashMap<String, Vec<DirEntry>>;
    type JsValue = DirTree;

    fn compute(&mut self) -> Result<Self::Output> {
        build_tree(&self.paths, &self.exclude)
    }

    fn resolve(&mut self, _env: Env, dirs: Self::Output) -> Result<Self::JsValue> {
        Ok(DirTree { dirs })
    }
}

/// An entry of a folder in a pack.
#[napi(object)]
#[derive(Clone)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[napi]
impl PackHolder {
    /// Paths (as stored in the pack, `/` separated) of all `.lua` files.
    #[napi]
    pub fn lua_paths(&self) -> Vec<String> {
        let mut paths: Vec<String> = self
            .pack
            .files()
            .values()
            .map(|f| f.path_in_container_raw().to_owned())
            .filter(|p| p.to_ascii_lowercase().ends_with(".lua"))
            .collect();
        paths.sort();
        paths
    }

    /// The folders of the pack, leaving out files matching any of the `exclude`
    /// globs (relative to the pack root, any case; without a `/` they match a
    /// name in any folder) and the folders left empty. Built on a worker thread.
    #[napi(ts_return_type = "Promise<DirTree>")]
    pub fn dir_tree_async(&self, exclude: Option<Vec<String>>) -> AsyncTask<DirTreeTask> {
        let paths = self.pack.files().values().map(|f| f.path_in_container_raw().to_owned()).collect();
        AsyncTask::new(DirTreeTask { paths, exclude: exclude.unwrap_or_default() })
    }

    /// Whether the pack has a file at this path (any case).
    #[napi]
    pub fn has_file(&self, path: String) -> bool {
        self.pack.file(&path, true).is_some()
    }

    /// Paths (as stored in the pack, `/` separated) of all files, sorted.
    #[napi]
    pub fn paths(&self) -> Vec<String> {
        let mut paths: Vec<String> = self.pack.files().values().map(|f| f.path_in_container_raw().to_owned()).collect();
        paths.sort();
        paths
    }

    /// Contents of a text file, or null when the pack has no such file.
    #[napi]
    pub fn read_text(&mut self, path: String) -> Result<Option<String>> {
        let Some(file) = self.pack.file_mut(&path, true) else {
            return Ok(None);
        };
        match file.decode(&None, false, true).map_err(to_napi("Could not decode file"))? {
            Some(RFileDecoded::Text(text)) => Ok(Some(text.contents().to_owned())),
            _ => {
                // Not recognised as text: fall back to the raw bytes.
                file.load().map_err(to_napi("Could not load file"))?;
                let data = file.cached().map_err(to_napi("Could not read file"))?;
                Ok(Some(String::from_utf8_lossy(data).into_owned()))
            }
        }
    }

    /// Raw contents of a file, or null when the pack has no such file.
    #[napi]
    pub fn read_bytes(&mut self, path: String) -> Result<Option<Buffer>> {
        let Some(file) = self.pack.file_mut(&path, true) else {
            return Ok(None);
        };
        file.load().map_err(to_napi("Could not load file"))?;
        let data = file.cached().map_err(to_napi("Could not read file"))?;
        Ok(Some(data.to_vec().into()))
    }

    /// The DB table fragments (`db/<table>/<file>`) in the pack.
    #[napi]
    pub fn db_files(&self) -> Vec<DbFile> {
        let mut files: Vec<DbFile> = self
            .pack
            .files()
            .values()
            .filter_map(|f| {
                let table = f.db_table_name_from_path()?.to_owned();
                Some(DbFile {
                    path: f.path_in_container_raw().to_owned(),
                    table,
                    pack: f.container_name().clone(),
                })
            })
            .collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        files
    }

    /// Decodes a DB table fragment with a schema. Null when the pack has no such file.
    #[napi]
    pub fn decode_db(&mut self, path: String, schema: &DbSchema) -> Result<Option<DbTable>> {
        let Some(file) = self.pack.file_mut(&path, true) else {
            return Ok(None);
        };
        decode_db_file(file, &path, schema).map(Some)
    }
}

/// Decodes a DB table fragment (an `RFile` at `db/<table>/<file>`).
fn decode_db_file(file: &mut RFile, path: &str, schema: &DbSchema) -> Result<DbTable> {
    let mut extra = DecodeableExtraData::default();
    extra.set_schema(Some(&schema.schema));
    let table = file.db_table_name_from_path().unwrap_or_default().to_owned();
    let decoded = match file.decode(&Some(extra), false, true) {
        Ok(decoded) => decoded,
        // An empty fragment of a table the schema doesn't know: nothing to show.
        Err(RLibError::DecodingDBNoDefinitionsFoundAndEmptyFile) => {
            return Ok(DbTable { table, version: -1, guid: String::new(), fields: vec![], rows: vec![] });
        }
        Err(e) => return Err(Error::from_reason(format!("Could not decode {path}: {e}"))),
    };
    let Some(RFileDecoded::DB(db)) = decoded else {
        return Err(Error::from_reason(format!("{path} is not a DB table")));
    };
    let definition = db.definition();
    Ok(DbTable {
        table: db.table_name().to_owned(),
        version: *definition.version(),
        guid: db.guid().clone(),
        fields: db_fields(definition, Some(db.patches())),
        rows: db.data().iter().map(|row| row.iter().map(to_db_value).collect()).collect(),
    })
}

fn db_fields(definition: &Definition, patches: Option<&DefinitionPatch>) -> Vec<DbField> {
    definition
        .fields_processed()
        .iter()
        .map(|f| {
            let reference = f.is_reference(patches);
            DbField {
                name: f.name().to_owned(),
                field_type: field_type_name(f.field_type()),
                is_key: f.is_key(patches),
                // Schemas name referenced tables without the "_tables" of their pack folder.
                ref_table: reference.as_ref().map(|r| table_folder_name(&r.0)),
                ref_column: reference.map(|r| r.1),
                description: Some(f.description(patches)).filter(|d| !d.is_empty()),
                default_value: f.default_value(patches),
                lookup: f.lookup(patches).filter(|l| !l.is_empty()),
            }
        })
        .collect()
}

/// The pack folder name of a table: `unit_armour_types` -> `unit_armour_types_tables`.
fn table_folder_name(table: &str) -> String {
    if table.ends_with("_tables") { table.to_owned() } else { format!("{table}_tables") }
}

/// Decodes a DB table fragment from its bytes (a loose `db/<table>/<file>` on disk).
#[napi]
pub fn decode_db_bytes(bytes: Buffer, table: String, schema: &DbSchema) -> Result<DbTable> {
    let path = format!("db/{table}/file");
    let mut file = RFile::new_from_vec(&bytes, FileType::DB, 0, &path);
    decode_db_file(&mut file, &path, schema)
}

/// A DB table fragment in a pack.
#[napi(object)]
pub struct DbFile {
    /// Path in the pack: `db/<table>/<file>`.
    pub path: String,
    /// Table name, e.g. `land_units_tables`.
    pub table: String,
    /// File name of the pack the fragment was read from.
    pub pack: Option<String>,
}

/// A column of a decoded DB table.
#[napi(object)]
pub struct DbField {
    pub name: String,
    pub field_type: String,
    pub is_key: bool,
    /// Table this column references, if any.
    pub ref_table: Option<String>,
    pub ref_column: Option<String>,
    pub description: Option<String>,
    /// The schema's default for new rows, as text.
    pub default_value: Option<String>,
    /// Columns of the referenced table that describe a key (e.g. its name).
    pub lookup: Option<Vec<String>>,
}

/// A decoded DB table fragment.
#[napi(object)]
pub struct DbTable {
    pub table: String,
    /// Version of the definition used to decode it.
    pub version: i32,
    /// GUID in the table's header (empty when it has none).
    pub guid: String,
    pub fields: Vec<DbField>,
    pub rows: Vec<Vec<DbValue>>,
}

pub type DbValue = Either3<bool, f64, String>;

fn to_db_value(value: &DecodedData) -> DbValue {
    match value {
        DecodedData::Boolean(b) => Either3::A(*b),
        DecodedData::F32(n) => Either3::B(f64::from(*n)),
        DecodedData::F64(n) => Either3::B(*n),
        DecodedData::I16(n) | DecodedData::OptionalI16(n) => Either3::B(f64::from(*n)),
        DecodedData::I32(n) | DecodedData::OptionalI32(n) => Either3::B(f64::from(*n)),
        DecodedData::I64(n) | DecodedData::OptionalI64(n) => Either3::B(*n as f64),
        DecodedData::SequenceU16(data) | DecodedData::SequenceU32(data) => {
            Either3::C(format!("<sequence, {} bytes>", data.len()))
        }
        other => Either3::C(other.data_to_string().into_owned()),
    }
}

fn field_type_name(field_type: &FieldType) -> String {
    match field_type {
        FieldType::SequenceU16(_) => "SequenceU16".to_owned(),
        FieldType::SequenceU32(_) => "SequenceU32".to_owned(),
        other => format!("{other:?}"),
    }
}

/// An RPFM schema (`schema_<game>.ron`), used to decode DB tables.
#[napi]
pub struct DbSchema {
    schema: Schema,
}

#[napi]
impl DbSchema {
    /// An empty table with the given version of a table's definition, or the
    /// newest one (null when the schema lacks it). The newest is not always the
    /// one the game uses: prefer the version of the game's own fragment.
    #[napi]
    pub fn empty_table(&self, table: String, version: Option<i32>) -> Option<DbTable> {
        let definitions = self.schema.definitions_by_table_name(&table)?;
        let definition = match version {
            Some(v) => definitions.iter().find(|d| *d.version() == v)?,
            None => definitions.iter().max_by_key(|d| *d.version())?,
        };
        let fields = db_fields(definition, self.schema.patches_for_table(&table));
        Some(DbTable { table, version: *definition.version(), guid: String::new(), fields, rows: vec![] })
    }

    /// Names of the tables the schema has definitions for.
    #[napi]
    pub fn table_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.schema.definitions().keys().cloned().collect();
        names.sort();
        names
    }
}

/// Encodes rows into a DB table fragment (the bytes of a `db/<table>/<file>`),
/// with the schema's definition of that table and version. Rows have one value
/// per column, in the order `decodeDb` returns them.
#[napi]
pub fn encode_db(schema: &DbSchema, table: String, version: i32, rows: Vec<Vec<DbValue>>, game: String, guid: Option<String>) -> Result<Buffer> {
    let info = game_info(&game)?;
    let definition = schema
        .schema
        .definition_by_name_and_version(&table, version)
        .ok_or_else(|| Error::from_reason(format!("The schema has no version {version} of {table}")))?;
    let patches = schema.schema.patches_for_table(&table);
    let fields = definition.fields_processed();
    let data = rows
        .iter()
        .enumerate()
        .map(|(r, row)| {
            if row.len() != fields.len() {
                return Err(Error::from_reason(format!("Row {r} has {} values, {table} v{version} has {} columns", row.len(), fields.len())));
            }
            row.iter()
                .zip(&fields)
                .map(|(value, field)| {
                    let text = match value {
                        Either3::A(b) => b.to_string(),
                        Either3::B(n) => n.to_string(),
                        Either3::C(s) => s.clone(),
                    };
                    DecodedData::new_from_type_and_string(field.field_type(), &text)
                        .map_err(|e| Error::from_reason(format!("Row {r}, {}: {e}", field.name())))
                })
                .collect::<Result<Vec<_>>>()
        })
        .collect::<Result<Vec<_>>>()?;
    let mut db = DB::new(definition, patches, &table);
    db.set_data(&data).map_err(to_napi("Invalid rows"))?;
    let mut bytes = vec![];
    db.encode(&mut bytes, &Some(EncodeableExtraData::new_from_game_info(info)))
        .map_err(to_napi("Could not encode table"))?;
    match guid.filter(|g| !g.is_empty()) {
        Some(guid) if *info.db_tables_have_guid() => Ok(with_guid(&bytes, &guid).into()),
        _ => Ok(bytes.into()),
    }
}

/// GUID header marker of DB tables (rpfm_lib's `GUID_MARKER`).
const GUID_MARKER: [u8; 4] = [253, 254, 252, 255];

/// Replaces the GUID rpfm_lib generated (`DB` has no setter) with `guid`, so a
/// saved table keeps its identity: marker, u16 length, UTF-16 characters.
fn with_guid(encoded: &[u8], guid: &str) -> Vec<u8> {
    if encoded.len() < 6 || encoded[..4] != GUID_MARKER {
        return encoded.to_vec();
    }
    let old_len = u16::from_le_bytes([encoded[4], encoded[5]]) as usize;
    let rest = &encoded[(6 + old_len * 2).min(encoded.len())..];
    let units: Vec<u16> = guid.encode_utf16().collect();
    let mut out = GUID_MARKER.to_vec();
    out.extend_from_slice(&(units.len() as u16).to_le_bytes());
    units.iter().for_each(|u| out.extend_from_slice(&u.to_le_bytes()));
    out.extend_from_slice(rest);
    out
}

fn load_schema_file(path: &str) -> Result<Schema> {
    Schema::load(Path::new(path), None).map_err(to_napi(&format!("Could not load schema {path}")))
}

/// Loads an RPFM schema file synchronously.
#[napi]
pub fn load_schema(path: String) -> Result<DbSchema> {
    Ok(DbSchema { schema: load_schema_file(&path)? })
}

pub struct LoadSchemaTask {
    path: String,
}

impl Task for LoadSchemaTask {
    type Output = Schema;
    type JsValue = DbSchema;

    fn compute(&mut self) -> Result<Self::Output> {
        load_schema_file(&self.path)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(DbSchema { schema: output })
    }
}

/// Loads an RPFM schema file on a worker thread.
#[napi(ts_return_type = "Promise<DbSchema>")]
pub fn load_schema_async(path: String) -> AsyncTask<LoadSchemaTask> {
    AsyncTask::new(LoadSchemaTask { path })
}

/// Opens and merges packs (lazy loaded) synchronously.
#[napi]
pub fn open_packs(paths: Vec<String>, game: String, keep_order: Option<bool>) -> Result<PackHolder> {
    Ok(PackHolder { pack: open(&paths, &game, keep_order.unwrap_or(false))? })
}

pub struct OpenPacksTask {
    paths: Vec<String>,
    game: String,
    keep_order: bool,
}

impl Task for OpenPacksTask {
    type Output = Pack;
    type JsValue = PackHolder;

    fn compute(&mut self) -> Result<Self::Output> {
        open(&self.paths, &self.game, self.keep_order)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(PackHolder { pack: output })
    }
}

/// Opens and merges packs on a worker thread.
#[napi(ts_return_type = "Promise<PackHolder>")]
pub fn open_packs_async(paths: Vec<String>, game: String, keep_order: Option<bool>) -> AsyncTask<OpenPacksTask> {
    AsyncTask::new(OpenPacksTask { paths, game, keep_order: keep_order.unwrap_or(false) })
}

fn create_pack(folder: &str, out_path: &str, game: &str, schema: &Option<Schema>) -> Result<u32> {
    let info = game_info(game)?;
    let folder = Path::new(folder);
    if !folder.is_dir() {
        return Err(Error::from_reason(format!("'{}' is not a folder", folder.display())));
    }
    let name = Path::new(out_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mod.pack".to_owned());
    let mut pack = Pack::new_with_name_and_version(&name, info.pfh_version_by_file_type(PFHFileType::Mod));
    pack.set_pfh_file_type(PFHFileType::Mod);

    // The folder mirrors the pack: its children (script/, db/, ...) go to the pack root.
    // TSV files (RPFM's text format, for version control) go in as the binary
    // file they describe, at their own path without ".tsv" (not the path in
    // their header, which goes stale when a file is renamed).
    let mut files = vec![];
    collect_files(folder, &mut files);
    files.sort();
    let mut inserted = 0u32;
    for disk_path in files {
        let rel = disk_path
            .strip_prefix(folder)
            .unwrap_or(&disk_path)
            .to_string_lossy()
            .replace('\\', "/");
        let rfile = if rel.to_lowercase().ends_with(".tsv") {
            let (_, kind, bytes) = tsv_import(&disk_path, schema, game)?;
            let mut target = rel[..rel.len() - 4].to_owned();
            if kind == "loc" && !target.to_lowercase().ends_with(".loc") {
                target.push_str(".loc");
            }
            let file_type = if kind == "loc" { FileType::Loc } else { FileType::DB };
            RFile::new_from_vec(&bytes, file_type, 0, &target)
        } else {
            let mut rfile = RFile::new_from_file_path(&disk_path).map_err(to_napi(&format!("Could not read {}", disk_path.display())))?;
            rfile.set_path_in_container_raw(&rel);
            rfile.load().map_err(to_napi(&format!("Could not read {}", disk_path.display())))?;
            rfile.guess_file_type().map_err(to_napi(&format!("Could not read {}", disk_path.display())))?;
            rfile
        };
        if pack.insert(rfile).map_err(to_napi(&format!("Could not add {rel}")))?.is_some() {
            inserted += 1;
        }
    }
    if inserted == 0 {
        return Err(Error::from_reason(format!("No files found in '{}'", folder.display())));
    }

    pack.save(Some(Path::new(out_path)), info, &None)
        .map_err(to_napi("Could not save pack"))?;
    Ok(inserted)
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_files(&path, out);
            } else {
                out.push(path);
            }
        }
    }
}

/// Whether `folder` has `.tsv` files (then packing needs the schema).
fn has_tsv(folder: &Path) -> bool {
    std::fs::read_dir(folder).map(|entries| {
        entries.flatten().any(|e| {
            let p = e.path();
            if p.is_dir() {
                has_tsv(&p)
            } else {
                p.extension().is_some_and(|x| x.eq_ignore_ascii_case("tsv"))
            }
        })
    }).unwrap_or(false)
}

fn schema_for(folder: &str, schema: Option<&DbSchema>) -> Option<Schema> {
    schema.filter(|_| has_tsv(Path::new(folder))).map(|s| s.schema.clone())
}

/// Builds a mod pack from a folder. Returns the number of files packed.
/// `.tsv` files are converted to binary DB tables / loc files (DB tables need `schema`).
#[napi]
pub fn create_pack_from_folder(folder: String, out_path: String, game: String, schema: Option<&DbSchema>) -> Result<u32> {
    let schema = schema_for(&folder, schema);
    create_pack(&folder, &out_path, &game, &schema)
}

pub struct CreatePackTask {
    folder: String,
    out_path: String,
    game: String,
    schema: Option<Schema>,
}

impl Task for CreatePackTask {
    type Output = u32;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        create_pack(&self.folder, &self.out_path, &self.game, &self.schema)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Builds a mod pack from a folder on a worker thread.
#[napi(ts_return_type = "Promise<number>")]
pub fn create_pack_from_folder_async(folder: String, out_path: String, game: String, schema: Option<&DbSchema>) -> AsyncTask<CreatePackTask> {
    let schema = schema_for(&folder, schema);
    AsyncTask::new(CreatePackTask { folder, out_path, game, schema })
}

/// Paths of the game's own (CA) packs, in load order, from the game's manifest.
/// `game_path` is the folder that contains the executable.
#[napi]
pub fn ca_pack_paths(game_path: String, game: String) -> Result<Vec<String>> {
    let info = game_info(&game)?;
    let paths = info
        .ca_packs_paths(Path::new(&game_path))
        .map_err(to_napi("Could not list the game's packs"))?;
    Ok(paths.iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

/// Game keys rpfm knows about.
#[napi]
pub fn supported_game_keys() -> Vec<String> {
    supported_games().game_keys_sorted().iter().map(|k| k.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn filtered_tree_drops_empty_folders() {
        let all = paths(&["audio/wwise/a.wem", "audio/b.WEM", "script/_lib/lib.lua", "ui/skins/x.png", "ui/y.xml"]);
        let tree = build_tree(&all, &["*.wem".into(), "ui/skins/**".into()]).unwrap();
        let names = |dir: &str| tree.get(dir).map(|e| e.iter().map(|e| e.name.clone()).collect::<Vec<_>>());
        assert_eq!(names(""), Some(vec!["script".to_owned(), "ui".to_owned()]));
        assert_eq!(names("audio"), None);
        assert_eq!(names("ui"), Some(vec!["y.xml".to_owned()]));
        assert_eq!(names("script/_lib"), Some(vec!["lib.lua".to_owned()]));
    }

    #[test]
    fn globs() {
        let m = |glob: &str, path: &str| {
            regex::RegexBuilder::new(&glob_to_regex(glob)).case_insensitive(true).build().unwrap().is_match(path)
        };
        assert!(m("**/*.wem", "audio/x/a.wem"));
        assert!(m("**/*.wem", "a.wem"));
        assert!(m("*.wem", "audio/x/A.WEM"));
        assert!(!m("audio/*.wem", "audio/x/a.wem"));
        assert!(m("audio", "audio/x/a.wem"));
        assert!(m("**/*.{anim,bmd}", "animations/a.bmd"));
        assert!(!m("**/*.{anim,bmd}", "animations/a.bmd.meta"));
        assert!(m("variantmeshes/**", "VariantMeshes/x/y.wsmodel"));
        assert!(!m("db/*", "dbx/a"));
    }
}

// ---- Localisation (.loc) -------------------------------------------------------

/// A row of a localisation (`.loc`) file.
#[napi(object)]
pub struct LocRow {
    pub key: String,
    pub text: String,
    pub tooltip: bool,
}

fn loc_rows(loc: &Loc) -> Vec<LocRow> {
    loc.data()
        .iter()
        .map(|r| LocRow {
            key: r.first().map(|v| v.data_to_string().into_owned()).unwrap_or_default(),
            text: r.get(1).map(|v| v.data_to_string().into_owned()).unwrap_or_default(),
            tooltip: matches!(r.get(2), Some(DecodedData::Boolean(true))),
        })
        .collect()
}

fn decode_loc_file(file: &mut RFile, path: &str) -> Result<Vec<LocRow>> {
    match file.decode(&None, false, true) {
        Ok(Some(RFileDecoded::Loc(loc))) => Ok(loc_rows(&loc)),
        Ok(_) => Err(Error::from_reason(format!("{path} is not a loc file"))),
        Err(e) => Err(Error::from_reason(format!("Could not decode {path}: {e}"))),
    }
}

/// Decodes a loc file from its bytes.
#[napi]
pub fn decode_loc_bytes(bytes: Buffer) -> Result<Vec<LocRow>> {
    let path = "text/file.loc";
    let mut file = RFile::new_from_vec(&bytes, FileType::Loc, 0, path);
    decode_loc_file(&mut file, path)
}

/// Encodes rows into the bytes of a loc file.
#[napi]
pub fn encode_loc(rows: Vec<LocRow>) -> Result<Buffer> {
    let mut loc = Loc::new();
    let data: Vec<Vec<DecodedData>> = rows
        .into_iter()
        .map(|r| vec![DecodedData::StringU16(r.key), DecodedData::StringU16(r.text), DecodedData::Boolean(r.tooltip)])
        .collect();
    loc.set_data(&data).map_err(to_napi("Invalid loc rows"))?;
    let mut bytes = vec![];
    loc.encode(&mut bytes, &None).map_err(to_napi("Could not encode loc file"))?;
    Ok(bytes.into())
}

#[napi]
impl PackHolder {
    /// Paths of the loc files in the packs.
    #[napi]
    pub fn loc_paths(&self) -> Vec<String> {
        let mut paths: Vec<String> = self
            .pack
            .files_by_type(&[FileType::Loc])
            .iter()
            .map(|f| f.path_in_container_raw().to_owned())
            .collect();
        paths.sort();
        paths
    }

    /// Decodes a loc file. Null when the pack has no such file.
    #[napi]
    pub fn decode_loc(&mut self, path: String) -> Result<Option<Vec<LocRow>>> {
        let Some(file) = self.pack.file_mut(&path, true) else {
            return Ok(None);
        };
        decode_loc_file(file, &path).map(Some)
    }
}

// ---- TSV ------------------------------------------------------------------------

/// A TSV file (RPFM's format) converted to a binary DB table or loc file.
#[napi(object)]
pub struct TsvImport {
    /// Path in the pack the TSV names in its header (`db/<table>/<file>`, `text/.../x.loc`).
    pub path: String,
    /// `"db"` or `"loc"`.
    pub kind: String,
    pub bytes: Buffer,
}

fn tsv_import(tsv: &Path, schema: &Option<Schema>, game: &str) -> Result<(String, String, Vec<u8>)> {
    let info = game_info(game)?;
    let mut file = RFile::tsv_import_from_path(tsv, schema)
        .map_err(to_napi(&format!("Could not read {}", tsv.display())))?;
    let kind = if matches!(file.file_type(), FileType::Loc) { "loc" } else { "db" };
    let bytes = file
        .encode(&Some(EncodeableExtraData::new_from_game_info(info)), false, false, true)
        .map_err(to_napi(&format!("Could not encode {}", tsv.display())))?
        .unwrap_or_default();
    Ok((file.path_in_container_raw().to_owned(), kind.to_owned(), bytes))
}

/// Converts a TSV file to the binary file it describes.
#[napi]
pub fn tsv_to_binary(tsv_path: String, schema: Option<&DbSchema>, game: String) -> Result<TsvImport> {
    let schema = schema.map(|s| s.schema.clone());
    let (path, kind, bytes) = tsv_import(Path::new(&tsv_path), &schema, &game)?;
    Ok(TsvImport { path, kind, bytes: bytes.into() })
}

/// Writes a binary DB table or loc file (`bytes`, at `pack_path` in a pack) as TSV.
#[napi]
pub fn binary_to_tsv(bytes: Buffer, pack_path: String, schema: &DbSchema, tsv_path: String) -> Result<()> {
    let file_type = if pack_path.to_lowercase().ends_with(".loc") { FileType::Loc } else { FileType::DB };
    let mut file = RFile::new_from_vec(&bytes, file_type, 0, &pack_path);
    file.tsv_export_to_path(Path::new(&tsv_path), &schema.schema, false)
        .map_err(to_napi(&format!("Could not write {tsv_path}")))
}
