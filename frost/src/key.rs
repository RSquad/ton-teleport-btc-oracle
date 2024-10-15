use core::ops::Neg;
use frost::keys::PublicKeyPackage;
use frost_secp256k1_tr as frost;
use k256::elliptic_curve::point::AffineCoordinates;
use k256::elliptic_curve::sec1::ToEncodedPoint;

pub struct XYEncodedPublicKey {
    pub bytes: [u8; 65],
}

impl XYEncodedPublicKey {
    pub fn from_public_key_package(pubkey_package: &PublicKeyPackage) -> Self {
        let point = pubkey_package.verifying_key().to_element().to_affine();
        let affine_point = if point.y_is_odd().into() {
            point.neg()
        } else {
            point
        };
        let encoded_point = affine_point.to_encoded_point(false);
        let point_bytes = encoded_point.as_bytes();
        let mut fixed_bytes: [u8; 65] = [0; 65];
        fixed_bytes.copy_from_slice(&point_bytes);
        assert_eq!(point_bytes.len(), fixed_bytes.len());
        Self { bytes: fixed_bytes }
    }
}

#[cfg(test)]
mod tests {
    use super::XYEncodedPublicKey;
    use frost_core::keys::PublicKeyPackage;
    use k256::elliptic_curve::sec1::FromEncodedPoint;
    use k256::{AffinePoint, EncodedPoint};
    #[test]
    fn test_extract_public_key_xy() {
        let serialized_package = hex::decode("00230f8ab3050000000000000000000000000000000000000000000000000000000000000001022b488f018eb9f8fe239cd02a170cd4a45af404093a6a61177521735329149a72000000000000000000000000000000000000000000000000000000000000000203f0abcae4cfde3b3ca2117b48444e2a65eb968a08e55990c83e60571219a9ceb4000000000000000000000000000000000000000000000000000000000000000302094a1eae34d12c8f0af74137ed7701e810fc804b94e5fa82145081f5027eecb200000000000000000000000000000000000000000000000000000000000000040275a17147af0a090ef1ea7d8505aa415a0d3b21a2cd8ca3116aeed4eccf26e69c000000000000000000000000000000000000000000000000000000000000000502dc748673b0e10ccff2044e10987a6371c623a30d35e6913eead74309756c09d903a971b7d228f7764f69f4b6da48b98203ed6cfa841771d14b94e09405fd3fef05").unwrap();
        let pubkey_package = PublicKeyPackage::deserialize(&serialized_package).unwrap();
        let key = XYEncodedPublicKey::from_public_key_package(&pubkey_package);
        let expected_pubkey = &pubkey_package.verifying_key().serialize()[1..];
        let received_pubkey = &key.bytes[1..33];
        assert_eq!(expected_pubkey, received_pubkey);

        let encoded_point = EncodedPoint::from_bytes(&key.bytes).unwrap();
        let _ =
            Option::<AffinePoint>::from(AffinePoint::from_encoded_point(&encoded_point)).unwrap();
    }
}
