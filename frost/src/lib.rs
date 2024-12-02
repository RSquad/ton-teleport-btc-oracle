mod key;
#[macro_use]
mod helper;

use frost_secp256k1_tr as frost;
use key::XYEncodedPublicKey;
use std::collections::BTreeMap;

use crate::frost::SigningTarget;
use ::bitcoin::key::{PublicKey, XOnlyPublicKey};
use frost::keys::dkg::{
    round1::Package as PackageRound1, round1::SecretPackage as SecretPackageRound1,
    round2::Package as PackageRound2, round2::SecretPackage as SecretPackageRound2,
};
use frost::keys::{KeyPackage, PublicKeyPackage};
use frost::round1::{SigningCommitments, SigningNonces};
use frost::{Identifier, Signature, SigningPackage, SigningParameters};
use frost_core::round2::SignatureShare;
use neon::prelude::*;
use neon::types::buffer::TypedArray;
use rand::thread_rng;
use std::{
    convert::{From, TryFrom, TryInto},
    path::Path,
};

fn cast<T: Sized>(ptr_str: String) -> Result<Box<T>, String> {
    unsafe {
        let ptr = ptr_str
            .parse::<usize>()
            .map_err(|e| format!("Invalid pointer: {}", e))? as *mut T;
        Ok(Box::from_raw(ptr))
    }
}

fn signing_target(
    cx: &FunctionContext,
    message: Handle<JsBuffer>,
    tap_merkle_root: Option<Handle<JsBuffer>>,
) -> SigningTarget {
    SigningTarget::new(
        message.as_slice(cx),
        SigningParameters {
            tapscript_merkle_root: tap_merkle_root
                .map(|v| v.as_slice(cx).to_vec())
                .or(Some(vec![])),
        },
    )
}

fn extract_verifying_key(cx: &mut FunctionContext, pubkey_buffer: Handle<JsBuffer>) -> [u8; 32] {
    let pubkey_package = PublicKeyPackage::deserialize(pubkey_buffer.as_slice(cx)).unwrap();
    let verifying_key_b = pubkey_package.verifying_key();
    let pubk = PublicKey::from_slice(&verifying_key_b.serialize()[..]).unwrap();
    let xpubk = XOnlyPublicKey::from(pubk.inner);
    xpubk.serialize()
}

fn derive_identifier(mut cx: FunctionContext) -> JsResult<JsString> {
    let participant_index = cx.argument::<JsBuffer>(0)?;
    let participant_identifier =
        Identifier::derive(participant_index.as_slice(&cx)).expect("should be nonzero");
    let js_identifier = cx.string(hex::encode(participant_identifier.serialize()));
    Ok(js_identifier)
}

fn decode_identifier(id_str: &str) -> Identifier {
    let mut id: [u8; 32] = [0; 32];
    hex::decode_to_slice(id_str, &mut id).unwrap();
    Identifier::deserialize(&id).unwrap()
}

fn dkg_part1(mut cx: FunctionContext) -> JsResult<JsObject> {
    let identifier = decode_identifier(cx.argument::<JsString>(0)?.value(&mut cx).as_str());
    let max_signers = cx.argument::<JsNumber>(1)?.value(&mut cx) as u16;
    let min_signers = cx.argument::<JsNumber>(2)?.value(&mut cx) as u16;

    let mut rng = thread_rng();

    let (secret_package, package) = js_throw_on_error!(
        cx,
        frost::keys::dkg::part1(identifier, max_signers, min_signers, &mut rng)
    );

    let result = JsObject::new(&mut cx);
    let secret_ptr = Box::into_raw(Box::new(secret_package)) as i64;
    let js_secret_ptr = cx.string(secret_ptr.to_string());
    let serialized_package = js_throw_on_error!(cx, package.serialize());
    let js_buffer_package = JsBuffer::external(&mut cx, serialized_package);
    result.set(&mut cx, "secretPackagePtr", js_secret_ptr)?;
    result.set(&mut cx, "packageBuffer", js_buffer_package)?;
    Ok(result)
}

fn dkg_part2(mut cx: FunctionContext) -> JsResult<JsObject> {
    let round1_secret_ptr_str = cx.argument::<JsString>(0)?.value(&mut cx);
    let round1_secret = js_throw_on_error!(cx, cast::<SecretPackageRound1>(round1_secret_ptr_str));
    let round1_packages_js = cx.argument::<JsArray>(1)?;

    let mut r1_packages = BTreeMap::new();
    let packages_len = round1_packages_js.len(&mut cx);
    for i in 0..packages_len {
        let package_obj: Handle<JsObject> = round1_packages_js.get(&mut cx, i)?;
        let identifier: Handle<JsString> = package_obj.get(&mut cx, "identifier")?;
        let package_js: Handle<JsBuffer> = package_obj.get(&mut cx, "package")?;
        let mut id: [u8; 32] = [0; 32];
        js_throw_on_error!(cx, hex::decode_to_slice(identifier.value(&mut cx), &mut id));
        let identifier = js_throw_on_error!(cx, Identifier::deserialize(&id));
        let package = js_throw_on_error!(cx, PackageRound1::deserialize(package_js.as_slice(&cx)));
        r1_packages.insert(identifier, package);
    }

    let (r2_secrets, r2_packages) =
        js_throw_on_error!(cx, frost::keys::dkg::part2(*round1_secret, &r1_packages));

    let js_round2_packages = JsArray::new(&mut cx, r2_packages.len() as u32);
    let mut i = 0;
    for (identifier, package) in r2_packages {
        let js_identifier = cx.string(hex::encode(identifier.serialize()));
        let package_serialized = js_throw_on_error!(cx, package.serialize());
        let js_buffer = JsBuffer::external(&mut cx, package_serialized);
        let package_obj = JsObject::new(&mut cx);
        package_obj.set(&mut cx, "identifier", js_identifier)?;
        package_obj.set(&mut cx, "package", js_buffer)?;
        js_round2_packages.set(&mut cx, i, package_obj)?;
        i += 1;
    }

    let result = JsObject::new(&mut cx);
    let secret_ptr = Box::into_raw(Box::new(r2_secrets)) as i64;
    let js_secret_ptr = cx.string(secret_ptr.to_string());
    result.set(&mut cx, "secretPtr", js_secret_ptr)?;
    result.set(&mut cx, "round2Packages", js_round2_packages)?;
    Ok(result)
}

fn dkg_part3(mut cx: FunctionContext) -> JsResult<JsObject> {
    let round2_secret_package_ptr_str_handle = cx.argument::<JsString>(0)?;
    let round1_packages_js = cx.argument::<JsArray>(1)?;
    let round2_packages_js = cx.argument::<JsArray>(2)?;

    let round2_secret_ptr_str = round2_secret_package_ptr_str_handle.value(&mut cx);

    let r2_secrets = js_throw_on_error!(cx, cast::<SecretPackageRound2>(round2_secret_ptr_str));

    let mut r1_packages = BTreeMap::new();
    let round1_packages_len = round1_packages_js.len(&mut cx);
    for i in 0..round1_packages_len {
        let package_obj: Handle<JsObject> = round1_packages_js.get(&mut cx, i)?;
        let identifier: Handle<JsString> = package_obj.get(&mut cx, "identifier")?;
        let buffer: Handle<JsBuffer> = package_obj.get(&mut cx, "package")?;
        let mut id: [u8; 32] = [0; 32];
        js_throw_on_error!(cx, hex::decode_to_slice(identifier.value(&mut cx), &mut id));
        let identifier = js_throw_on_error!(cx, Identifier::deserialize(&id));
        let package = js_throw_on_error!(cx, PackageRound1::deserialize(buffer.as_slice(&cx)));
        r1_packages.insert(identifier, package);
    }

    let mut r2_packages = BTreeMap::new();
    let round2_packages_len = round2_packages_js.len(&mut cx);
    for i in 0..round2_packages_len {
        let package_obj: Handle<JsObject> = round2_packages_js.get(&mut cx, i)?;
        let identifier: Handle<JsString> = package_obj.get(&mut cx, "identifier")?;
        let buffer: Handle<JsBuffer> = package_obj.get(&mut cx, "package")?;
        let mut id: [u8; 32] = [0; 32];
        js_throw_on_error!(cx, hex::decode_to_slice(identifier.value(&mut cx), &mut id));
        let identifier = js_throw_on_error!(cx, Identifier::deserialize(&id));
        let package = js_throw_on_error!(cx, PackageRound2::deserialize(buffer.as_slice(&cx)));
        r2_packages.insert(identifier, package);
    }

    let (key_package, pubkey_package) = js_throw_on_error!(
        cx,
        frost::keys::dkg::part3(&r2_secrets, &r1_packages, &r2_packages)
    );

    let key_package_serialized = js_throw_on_error!(cx, key_package.serialize());
    let key_package_js = JsBuffer::external(&mut cx, key_package_serialized);

    let encoded_key_xy = XYEncodedPublicKey::from_public_key_package(&pubkey_package);

    let verifying_key_js = JsBuffer::external(&mut cx, encoded_key_xy.bytes);
    let pubkey_package_serialized = js_throw_on_error!(cx, pubkey_package.serialize());
    let public_key_package_js = JsBuffer::external(&mut cx, pubkey_package_serialized);
    let result = JsObject::new(&mut cx);
    result.set(&mut cx, "keyPackage", key_package_js)?;
    result.set(&mut cx, "publicKeyPackage", public_key_package_js)?;
    result.set(&mut cx, "verifyingKey", verifying_key_js)?;
    Ok(result)
}

fn commit(mut cx: FunctionContext) -> JsResult<JsObject> {
    let key_package_buffer = cx.argument::<JsBuffer>(0)?;
    let key_package = js_throw_on_error!(
        cx,
        KeyPackage::deserialize(key_package_buffer.as_slice(&mut cx))
    );
    let key_package = js_throw_on_error!(cx, frost::keys::KeyPackage::try_from(key_package));
    let mut rng = thread_rng();
    let (nonces, commitments) = frost::round1::commit(key_package.signing_share(), &mut rng);

    let js_nonce_buf = JsBuffer::external(&mut cx, js_throw_on_error!(cx, nonces.serialize()));

    let commitments_serialized = js_throw_on_error!(cx, commitments.serialize());
    let commitments_buf = JsBuffer::external(&mut cx, commitments_serialized);
    let result = JsObject::new(&mut cx);
    result.set(&mut cx, "signingCommitments", commitments_buf)?;
    result.set(&mut cx, "signingNonce", js_nonce_buf)?;
    Ok(result)
}

fn create_signing_package(mut cx: FunctionContext) -> JsResult<JsBuffer> {
    let commitments_array = cx.argument::<JsArray>(0)?;
    let message = cx.argument::<JsBuffer>(1)?;
    let tap_merkle_root = cx
        .argument_opt(2)
        .and_then(|arg| arg.downcast::<JsBuffer, _>(&mut cx).ok());
    let mut commitments_map = BTreeMap::new();
    for i in 0..commitments_array.len(&mut cx) {
        let obj: Handle<JsObject> = commitments_array.get(&mut cx, i)?;
        let identifier: Handle<JsString> = obj.get(&mut cx, "identifier")?;
        let buffer: Handle<JsBuffer> = obj.get(&mut cx, "package")?;

        let mut id: [u8; 32] = [0; 32];
        js_throw_on_error!(cx, hex::decode_to_slice(identifier.value(&mut cx), &mut id));
        let identifier = js_throw_on_error!(cx, Identifier::deserialize(&id));
        let commitments =
            js_throw_on_error!(cx, SigningCommitments::deserialize(buffer.as_slice(&cx)));
        commitments_map.insert(identifier, commitments);
    }

    let signing_package = frost::SigningPackage::new(
        commitments_map,
        signing_target(&cx, message, tap_merkle_root),
    );

    let signing_package_buf =
        JsBuffer::external(&mut cx, js_throw_on_error!(cx, signing_package.serialize()));
    Ok(signing_package_buf)
}

fn sign(mut cx: FunctionContext) -> JsResult<JsBuffer> {
    let signing_package_buff: Handle<JsBuffer> = cx.argument::<JsBuffer>(0)?;
    let nonce_buf: Handle<JsBuffer> = cx.argument::<JsBuffer>(1)?;
    let key_package_buffer: Handle<JsBuffer> = cx.argument::<JsBuffer>(2)?;

    let nonces = js_throw_on_error!(cx, SigningNonces::deserialize(nonce_buf.as_slice(&mut cx)));
    let key_package = js_throw_on_error!(
        cx,
        KeyPackage::deserialize(key_package_buffer.as_slice(&mut cx))
    );
    let signing_package = js_throw_on_error!(
        cx,
        SigningPackage::deserialize(signing_package_buff.as_slice(&mut cx))
    );
    let signature_share = js_throw_on_error!(
        cx,
        frost::round2::sign(&signing_package, &nonces, &key_package)
    );
    let signature_share_buff = JsBuffer::external(&mut cx, signature_share.serialize());
    Ok(signature_share_buff)
}

fn aggregate(mut cx: FunctionContext) -> JsResult<JsBuffer> {
    let signing_package_buf: Handle<JsBuffer> = cx.argument::<JsBuffer>(0)?;
    let signature_shares_array: Handle<JsArray> = cx.argument::<JsArray>(1)?;
    let pubkey_package_buf: Handle<JsBuffer> = cx.argument::<JsBuffer>(2)?;

    let signing_package = js_throw_on_error!(
        cx,
        SigningPackage::deserialize(signing_package_buf.as_slice(&mut cx))
    );

    let mut signature_shares_map = BTreeMap::new();
    let len = signature_shares_array.len(&mut cx);
    for i in 0..len {
        let obj: Handle<JsObject> = js_throw_on_error!(cx, signature_shares_array.get(&mut cx, i));
        let identifier: Handle<JsString> = obj.get(&mut cx, "identifier")?;
        let buffer: Handle<JsBuffer> = obj.get(&mut cx, "package")?;

        let mut id: [u8; 32] = [0; 32];
        js_throw_on_error!(cx, hex::decode_to_slice(identifier.value(&mut cx), &mut id));
        let identifier = js_throw_on_error!(cx, Identifier::deserialize(&id));

        let signature_share_bytes: [u8; 32] =
            js_throw_on_error!(cx, buffer.as_slice(&mut cx).try_into());
        let signature_share =
            js_throw_on_error!(cx, SignatureShare::deserialize(signature_share_bytes));
        signature_shares_map.insert(identifier, signature_share);
    }

    let pubkey = js_throw_on_error!(
        cx,
        PublicKeyPackage::deserialize(pubkey_package_buf.as_slice(&mut cx))
    );
    let signature = js_throw_on_error!(
        cx,
        frost::aggregate(&signing_package, &signature_shares_map, &pubkey)
    );
    let signature_buffer = JsBuffer::external(&mut cx, signature.serialize());
    Ok(signature_buffer)
}

fn verify(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let pubkey_package_buf: Handle<JsBuffer> = cx.argument::<JsBuffer>(0)?;
    let message_buf = cx.argument::<JsBuffer>(1)?;
    let signature_buf = cx.argument::<JsBuffer>(2)?;
    let tap_merkle_root_buf = cx
        .argument_opt(3)
        .and_then(|arg| arg.downcast::<JsBuffer, _>(&mut cx).ok());
    let signature_as_slice = js_throw_on_error!(cx, signature_buf.as_slice(&cx).try_into());
    let signature = js_throw_on_error!(cx, Signature::deserialize(signature_as_slice));
    let pubkey_package = js_throw_on_error!(
        cx,
        PublicKeyPackage::deserialize(pubkey_package_buf.as_slice(&mut cx))
    );
    js_throw_on_error!(
        cx,
        pubkey_package.verifying_key().verify(
            signing_target(&cx, message_buf, tap_merkle_root_buf),
            &signature,
        )
    );

    Ok(JsUndefined::new(&mut cx))
}

fn get_schnorr_pubkey(mut cx: FunctionContext) -> JsResult<JsBuffer> {
    let pubkey_package = cx.argument::<JsBuffer>(0)?;
    let verifiying_key = extract_verifying_key(&mut cx, pubkey_package);
    Ok(JsBuffer::external(&mut cx, verifiying_key))
}

/// Allows to store secret key in persistent memory (file)
/// arg0: string - relative path to directory where to store secret
/// arg1: Buffer - public key package (from dkg::part3)
/// arg2: Buffer - secret package (from dkg::part3)
/// Return: Undefined
fn store_secret_key(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let path = cx.argument::<JsString>(0)?.value(&mut cx);
    let pubkey_buf = cx.argument::<JsBuffer>(1)?;
    let secret_buf = cx.argument::<JsBuffer>(2)?;
    let secret = js_throw_on_error!(cx, KeyPackage::deserialize(secret_buf.as_slice(&mut cx)));
    let verifiying_key = extract_verifying_key(&mut cx, pubkey_buf);
    js_throw_on_error!(
        cx,
        std::fs::write(
            Path::new(&path).join(hex::encode(verifiying_key) + ".secret"),
            js_throw_on_error!(cx, secret.serialize()),
        )
    );
    Ok(JsUndefined::new(&mut cx))
}

/// Allows to load secret key from persistent memory (file)
/// arg0: string - relative path to directory where to find secret
/// arg1: Buffer - public key package (from dkg::part3)
/// Return: Buffer
fn load_secret_key(mut cx: FunctionContext) -> JsResult<JsBuffer> {
    let path = cx.argument::<JsString>(0)?.value(&mut cx);
    let pubkey_buf = cx.argument::<JsBuffer>(1)?;
    let verifiying_key = extract_verifying_key(&mut cx, pubkey_buf);
    let secret = js_throw_on_error!(
        cx,
        std::fs::read(Path::new(&path).join(hex::encode(verifiying_key) + ".secret"))
    );
    let secret_buf = JsBuffer::external(&mut cx, secret);
    Ok(secret_buf)
}

fn from_public_key_package(mut cx: FunctionContext) -> JsResult<JsObject> {
    let pubkey_package_buf: Handle<JsBuffer> = cx.argument::<JsBuffer>(0)?;
    let pubkey_package = js_throw_on_error!(
        cx,
        PublicKeyPackage::deserialize(pubkey_package_buf.as_slice(&mut cx))
    );
    let encoded_key_xy = XYEncodedPublicKey::from_public_key_package(&pubkey_package);
    let verifying_key_js = JsBuffer::external(&mut cx, encoded_key_xy.bytes);
    let result = JsObject::new(&mut cx);
    result.set(&mut cx, "verifyingKey", verifying_key_js)?;
    Ok(result)
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("deriveIdentifier", derive_identifier)?;
    cx.export_function("dkgPart1", dkg_part1)?;
    cx.export_function("dkgPart2", dkg_part2)?;
    cx.export_function("dkgPart3", dkg_part3)?;
    cx.export_function("commit", commit)?;
    cx.export_function("createSigningPackage", create_signing_package)?;
    cx.export_function("sign", sign)?;
    cx.export_function("aggregate", aggregate)?;
    cx.export_function("verify", verify)?;
    cx.export_function("getSchnorrPubkey", get_schnorr_pubkey)?;
    cx.export_function("loadSecretKey", load_secret_key)?;
    cx.export_function("storeSecretKey", store_secret_key)?;
    cx.export_function("fromPublicKeyPackage", from_public_key_package)?;
    Ok(())
}
