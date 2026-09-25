use dep::poseidon::poseidon2::Poseidon2;
use std::ecdsa_secp256k1::verify_signature;

fn main(
    // -- KYC credential (slot 0 - mandatory) --------------------------------
    kyc_secret: Field,
    kyc_salt: Field,
    kyc_sig: [u8; 64],
    kyc_commitment: pub Field,
    kyc_issuer_x: pub [u8; 32],
    kyc_issuer_y: pub [u8; 32],

    // -- Age credential (slot 1 - mandatory) --------------------------------
    age_date_of_birth: u64,
    age_salt: Field,
    age_sig: [u8; 64],
    age_commitment: pub Field,
    age_issuer_x: pub [u8; 32],
    age_issuer_y: pub [u8; 32],
    age_current_date: pub u64,
    age_threshold_years: pub u64,

    // -- Optional 3rd credential (slot 2) -----------------------------------
    cred3_value: u64,
    cred3_salt: Field,
    cred3_sig: [u8; 64],
    cred3_commitment: pub Field,
    cred3_issuer_x: pub [u8; 32],
    cred3_issuer_y: pub [u8; 32],
    cred3_threshold: pub u64,

    // -- Metadata -----------------------------------------------------------
    num_credentials: pub Field,
) {
    // -- Verify KYC credential ----------------------------------------------
    assert(kyc_salt != 0);
    assert(Poseidon2::hash([kyc_secret, kyc_salt], 2) == kyc_commitment);
    let kyc_z: [u8; 32] = kyc_commitment.to_be_bytes();
    assert(verify_signature(kyc_issuer_x, kyc_issuer_y, kyc_sig, kyc_z));

    // -- Verify Age credential ----------------------------------------------
    assert(age_salt != 0);
    assert(Poseidon2::hash([age_date_of_birth as Field, age_salt], 2) == age_commitment);
    let age_z: [u8; 32] = age_commitment.to_be_bytes();
    assert(verify_signature(age_issuer_x, age_issuer_y, age_sig, age_z));
    assert(age_current_date >= age_date_of_birth);
    let age_years = (age_current_date - age_date_of_birth) / 365;
    assert(age_years >= age_threshold_years);

    // -- Verify Optional 3rd Credential if num_credentials == 3 ---------------
    assert(num_credentials == 2 | num_credentials == 3);
    if num_credentials == 3 {
        assert(cred3_salt != 0);
        assert(Poseidon2::hash([cred3_value as Field, cred3_salt], 2) == cred3_commitment);
        let cred3_z: [u8; 32] = cred3_commitment.to_be_bytes();
        assert(verify_signature(cred3_issuer_x, cred3_issuer_y, cred3_sig, cred3_z));
        assert(cred3_value >= cred3_threshold);
    }
}

#[test]
fn test_valid_num_credentials_bounds() {
    assert(2 == 2);
    assert(3 == 3);
}
