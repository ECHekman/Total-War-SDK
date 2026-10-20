import * as assert from 'node:assert/strict';

import { findAssetReferences, pathPrefixAt, toPackPath } from '../../src/assets/references';

describe('asset references', () => {
	it('finds model and texture paths in a variant mesh definition', () => {
		const vmd = [
			'<VARIANT_MESH>',
			'  <SLOT name="body">',
			'    <VARIANT_MESH model="VariantMeshes\\wh3_main_kho\\tex\\body_01.rigid_model_v2" mask_image="variantmeshes/wh3_main_kho/tex/mask.dds"/>',
			'    <VARIANT_MESH model="variantmeshes/wh3_main_kho/body_02.wsmodel" imposter_model=""/>',
			'  </SLOT>',
			'</VARIANT_MESH>',
		].join('\n');
		const refs = findAssetReferences(vmd);
		assert.deepEqual(refs.map((r) => r.path), [
			'VariantMeshes/wh3_main_kho/tex/body_01.rigid_model_v2',
			'variantmeshes/wh3_main_kho/tex/mask.dds',
			'variantmeshes/wh3_main_kho/body_02.wsmodel',
		]);
		for (const r of refs) {
			assert.equal(vmd.slice(r.start, r.end), r.text);
		}
	});

	it('finds paths in element text (wsmodel, material)', () => {
		const ws = '<model><geometry>variantmeshes/x/a.rigid_model_v2</geometry><material lod_index="0">variantmeshes/x/materials/a.xml.material</material><texture> textures/a_base_colour.dds </texture></model>';
		assert.deepEqual(findAssetReferences(ws).map((r) => r.text), [
			'variantmeshes/x/a.rigid_model_v2',
			'variantmeshes/x/materials/a.xml.material',
			'textures/a_base_colour.dds',
		]);
	});

	it('ignores names without a folder and unknown extensions', () => {
		assert.deepEqual(findAssetReferences('<a b="body.rigid_model_v2" c="x/y.lua" d="wh3_main_kho">text/x.dds is here</a>'), []);
	});

	it('normalises written paths', () => {
		assert.equal(toPackPath(' \\VariantMeshes\\\\a\\b.dds '), 'VariantMeshes/a/b.dds');
	});

	it('finds the path being typed', () => {
		assert.deepEqual(pathPrefixAt('<x model="variantmeshes/wh3', 27), { start: 10, prefix: 'variantmeshes/wh3' });
		assert.deepEqual(pathPrefixAt('<x model="', 10), { start: 10, prefix: '' });
		assert.equal(pathPrefixAt('<x model', 8), undefined);
	});
});
